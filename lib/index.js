import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "schemastery";
import { readFile, writeFile } from "node:fs/promises";
import { openSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
//#region src/index.ts
/** 公告段落在工具指引区内的排序（210 与 language-input 同段位，靠后）。 */
const SECTION_ORDER = 210;
/** 智谱 API Key 的持久化文件名（位于 DSH home 目录）。 */
const ZHIPU_KEY_FILE = "speech-input-key";
/** host 侧 Key 读写路由（同源相对路径，client 用 fetch 调用）。 */
const ZHIPU_KEY_ROUTE = "/dsh-speech-input/key";
/** host 侧 FunASR 转写代理路由（client 用 fetch 调用）。 */
const FUNASR_TRANSCRIBE_ROUTE = "/dsh-speech-input/transcribe";
/** host 侧 FunASR 状态检查路由。 */
const FUNASR_STATUS_ROUTE = "/dsh-speech-input/funasr/status";
/** host 侧 FunASR 自动启动路由。 */
const FUNASR_START_ROUTE = "/dsh-speech-input/funasr/start";
/** 智谱 API Key 持久化文件路径（~/.dsh/speech-input-key）。 */
function keyFilePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, ZHIPU_KEY_FILE);
}
/** 仅接受回环同源请求（防 DNS rebinding / 局域网读取密钥）。 */
function isTrustedLoopback(request) {
	const host = typeof request.headers.host === "string" ? request.headers.host.toLowerCase() : "";
	return host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
}
/** 收集请求体（原始 http 流）。 */
function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}
/** 收集二进制请求体（原始 http 流）。 */
function readBuffer(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}
/**
* 挂载智谱 API Key 的持久化路由：
* - GET  /dsh-speech-input/key → 读取 ~/.dsh/speech-input-key，返回 { key }；
* - PUT  /dsh-speech-input/key → 写入 body { key } 到同一文件。
* 让 Key 摆脱浏览器 localStorage 的 origin（端口）隔离，跨启动持久。
*/
function mountKeyRoutes(host) {
	return host.webServer.register({
		kind: "exact",
		path: ZHIPU_KEY_ROUTE,
		handler: async (request, response) => {
			if (!isTrustedLoopback(request)) {
				response.writeHead(403);
				response.end();
				return;
			}
			if (request.method === "GET") {
				let key = "";
				try {
					key = (await readFile(keyFilePath(), "utf8")).trim();
				} catch {
					key = "";
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ key }));
				return;
			}
			if (request.method === "PUT" || request.method === "POST") {
				try {
					const body = await readBody(request);
					const parsed = JSON.parse(body);
					const key = typeof parsed.key === "string" ? parsed.key.trim() : "";
					await writeFile(keyFilePath(), key, "utf8");
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ ok: true }));
				} catch (error) {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				}
				return;
			}
			response.writeHead(405);
			response.end();
		}
	});
}
/** 宿主侧 FunASR 代理转发超时（毫秒）。 */
const FUNASR_TIMEOUT_MS = 9e4;
/** 已由插件自动启动的 FunASR 子进程（按基础地址索引）。 */
const funasrProcesses = /* @__PURE__ */ new Map();
/** 自动启动的 FunASR 最近一次被使用的时间戳（毫秒）。 */
const funasrLastUsedAt = /* @__PURE__ */ new Map();
/** 各地址配置的闲置退出分钟数（由最近一次转写请求带来）。 */
const funasrIdleMinutes = /* @__PURE__ */ new Map();
/** 闲置巡检间隔（毫秒）：每分钟扫一次，够用且开销可忽略。 */
const FUNASR_IDLE_SWEEP_INTERVAL_MS = 6e4;
/** 闲置巡检定时器。 */
let funasrIdleTimer;
/** 记录一次使用：刷新最近使用时间与闲置策略。 */
function touchFunasrUsage(key, idleMinutes) {
	funasrLastUsedAt.set(key, Date.now());
	funasrIdleMinutes.set(key, idleMinutes);
}
/**
* 结束一个由插件启动的 FunASR 进程。
* `spawn` 用了 `shell: true`，拿到的 pid 是 cmd.exe，普通 kill 只杀壳不杀 python，
* 因此 Windows 上必须 `taskkill /T` 递归结束整个进程树。
*/
function stopFunasrProcess(key) {
	const child = funasrProcesses.get(key);
	funasrProcesses.delete(key);
	funasrLastUsedAt.delete(key);
	funasrIdleMinutes.delete(key);
	if (child === void 0 || child.pid === void 0) return;
	try {
		if (process.platform === "win32") spawnSync("taskkill", [
			"/PID",
			String(child.pid),
			"/T",
			"/F"
		], {
			windowsHide: true,
			stdio: "ignore"
		});
		else try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
	} catch {
		try {
			child.kill();
		} catch {}
	}
}
/** 巡检：回收闲置超时的自动启动进程。只回收插件自己拉起的，不动用户手动启动的。 */
function sweepIdleFunasrProcesses() {
	const now = Date.now();
	for (const [key, lastUsed] of funasrLastUsedAt) {
		const minutes = funasrIdleMinutes.get(key) ?? 0;
		if (minutes <= 0) continue;
		if (now - lastUsed >= minutes * 6e4) stopFunasrProcess(key);
	}
}
/** 启动闲置巡检（幂等）。 */
function startFunasrIdleSweeper() {
	if (funasrIdleTimer !== void 0) return;
	funasrIdleTimer = setInterval(sweepIdleFunasrProcesses, FUNASR_IDLE_SWEEP_INTERVAL_MS);
	funasrIdleTimer.unref?.();
}
/** 停止闲置巡检，并回收全部由插件启动的进程。 */
function stopFunasrIdleSweeper() {
	if (funasrIdleTimer !== void 0) {
		clearInterval(funasrIdleTimer);
		funasrIdleTimer = void 0;
	}
	for (const key of [...funasrLastUsedAt.keys()]) stopFunasrProcess(key);
}
/** 去尾部斜杠的 FunASR 基础地址。 */
function normalizeFunasrBaseUrl(raw) {
	return (raw.trim() || "http://127.0.0.1:8000").replace(/\/+$/, "");
}
/** 探测本地 FunASR 健康接口是否可用。 */
async function isFunasrHealthy(baseUrl) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2e3);
	try {
		return (await fetch(`${normalizeFunasrBaseUrl(baseUrl)}/health`, { signal: controller.signal })).ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
/** FunASR 子进程日志路径（自动启动失败时唯一可查的线索）。 */
function funasrLogPath() {
	return join(homedir(), ".dsh", "speech-input-funasr.log");
}
/** 在日志里写入本次启动的上下文（命令、工作目录、时间）。 */
function writeFileSyncMarker(fd, command, cwd) {
	try {
		const header = `\n===== ${(/* @__PURE__ */ new Date()).toISOString()} spawn =====\ncwd: ${cwd}\ncmd: ${command}\n`;
		const buf = Buffer.from(header, "utf8");
		let written = 0;
		while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
	} catch {}
}
/** 启动本地 FunASR 子进程（已有未退出进程时直接复用）。 */
function spawnFunasrProcess(baseUrl, command, cwd) {
	const key = normalizeFunasrBaseUrl(baseUrl);
	const existing = funasrProcesses.get(key);
	if (existing && !existing.killed) return existing;
	let logFd = null;
	try {
		logFd = openSync(funasrLogPath(), "a");
	} catch {
		logFd = null;
	}
	if (logFd !== null) writeFileSyncMarker(logFd, command, cwd);
	const child = spawn(command, {
		cwd: cwd.trim() || void 0,
		shell: true,
		detached: true,
		stdio: logFd === null ? "ignore" : [
			"ignore",
			logFd,
			logFd
		],
		windowsHide: true
	});
	funasrProcesses.set(key, child);
	child.once("exit", () => {
		if (funasrProcesses.get(key) === child) funasrProcesses.delete(key);
	});
	child.once("error", () => {
		if (funasrProcesses.get(key) === child) funasrProcesses.delete(key);
	});
	child.unref();
	touchFunasrUsage(key, funasrIdleMinutes.get(key) ?? 0);
	return child;
}
/**
* 挂载 FunASR 生命周期路由：
* - GET  /dsh-speech-input/funasr/status?url=... → { running }
* - POST /dsh-speech-input/funasr/start?url=&command=&cwd= → 拉起本地进程。
*/
function mountFunasrLifecycleRoutes(host) {
	startFunasrIdleSweeper();
	const disposeStatus = host.webServer.register({
		kind: "exact",
		path: FUNASR_STATUS_ROUTE,
		handler: async (request, response) => {
			if (!isTrustedLoopback(request)) {
				response.writeHead(403);
				response.end();
				return;
			}
			if (request.method !== "GET") {
				response.writeHead(405);
				response.end();
				return;
			}
			const running = await isFunasrHealthy(normalizeFunasrBaseUrl(new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("url") ?? ""));
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ running }));
		}
	});
	const disposeStart = host.webServer.register({
		kind: "exact",
		path: FUNASR_START_ROUTE,
		handler: async (request, response) => {
			if (!isTrustedLoopback(request)) {
				response.writeHead(403);
				response.end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405);
				response.end();
				return;
			}
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			const baseUrl = normalizeFunasrBaseUrl(requestUrl.searchParams.get("url") ?? "");
			const command = (requestUrl.searchParams.get("command") ?? "").trim();
			const cwd = requestUrl.searchParams.get("cwd") ?? "";
			if (await isFunasrHealthy(baseUrl)) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({
					started: false,
					running: true
				}));
				return;
			}
			if (command === "") {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "no-command" }));
				return;
			}
			const key = normalizeFunasrBaseUrl(baseUrl);
			if (funasrProcesses.has(key)) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({
					started: false,
					running: false,
					starting: true
				}));
				return;
			}
			spawnFunasrProcess(baseUrl, command, cwd);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				started: true,
				running: false,
				starting: true
			}));
		}
	});
	return () => {
		disposeStatus();
		disposeStart();
		stopFunasrIdleSweeper();
	};
}
/**
* 挂载 FunASR 转写代理路由：
* - POST /dsh-speech-input/transcribe?url=<funasrBaseUrl>&model=<model>
*   body = audio/wav 二进制。
* 宿主把 WAV 转发到本地 FunASR OpenAI 兼容服务 `/v1/audio/transcriptions`，
* 浏览器侧因此不需要处理 CORS，也不需要把任何云 API Key 暴露给页面。
*/
function mountFunasrTranscribeRoute(host) {
	return host.webServer.register({
		kind: "exact",
		path: FUNASR_TRANSCRIBE_ROUTE,
		handler: async (request, response) => {
			if (!isTrustedLoopback(request)) {
				response.writeHead(403);
				response.end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405);
				response.end();
				return;
			}
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			const baseUrl = (requestUrl.searchParams.get("url") ?? "").trim() || "http://127.0.0.1:8000";
			const model = (requestUrl.searchParams.get("model") ?? "").trim() || "sensevoice";
			const idleRaw = Number(requestUrl.searchParams.get("idle"));
			const idleMinutes = Number.isFinite(idleRaw) ? Math.max(0, Math.min(480, Math.trunc(idleRaw))) : 0;
			if (funasrProcesses.has(normalizeFunasrBaseUrl(baseUrl))) touchFunasrUsage(normalizeFunasrBaseUrl(baseUrl), idleMinutes);
			let audio;
			try {
				audio = await readBuffer(request);
			} catch {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "bad-request" }));
				return;
			}
			if (audio.length === 0) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "bad-request" }));
				return;
			}
			const form = new FormData();
			form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
			form.append("model", model);
			form.append("response_format", "verbose_json");
			const upstream = `${baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FUNASR_TIMEOUT_MS);
			try {
				const upstreamResponse = await fetch(upstream, {
					method: "POST",
					body: form,
					signal: controller.signal
				});
				if (!upstreamResponse.ok) {
					const detail = await upstreamResponse.text().catch(() => "");
					response.writeHead(502, { "content-type": "application/json" });
					response.end(JSON.stringify({
						error: "funasr-http",
						status: upstreamResponse.status,
						detail: detail.slice(0, 500)
					}));
					return;
				}
				const payload = await upstreamResponse.json();
				if (typeof payload.text !== "string") {
					response.writeHead(502, { "content-type": "application/json" });
					response.end(JSON.stringify({
						error: "funasr-http",
						detail: String(payload.error ?? "no text")
					}));
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ text: payload.text }));
			} catch (error) {
				const aborted = error instanceof Error && (error.name === "AbortError" || error.message === "aborted");
				response.writeHead(aborted ? 504 : 502, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: aborted ? "funasr-timeout" : "funasr-offline" }));
			} finally {
				clearTimeout(timer);
			}
		}
	});
}
const inject = ["systemPrompt"];
/** 面向模型的公告：插件存在、能力与限制。 */
const SPEECH_INPUT_GUIDANCE = "本机已安装 dsh-speech-input 插件（DSH 的语音输入/语音转文字）：聊天输入框右下角新增「语音」按钮（麦克风），点击开始录音（或长按空格键说话、松开结束），录音结束后可选用本机 FunASR 本地转写（默认，需在语音设置中配置 FunASR 服务地址与模型；音频不出本机）或智谱 GLM-ASR-2512 云端转写（需配置智谱 API Key；单次录音最长 30 秒；语言由模型自动检测，支持中英及多种方言），识别文本自动填入输入框；支持追加或替换两种插入模式；Web 端与 DSH Desktop 端行为一致。用户提到「语音输入 / 语音识别 / 语音转文字 / 用语音说话 / 听写 / STT」时即指本插件，请据此协作。";
/** 公告能力的设置命名空间（web 设置面可编辑开关；浏览器侧不依赖宿主包）。 */
const SPEECH_INPUT_SETTINGS_NAMESPACE = settingsNamespace("speech-input");
const Config = z.object({
	announceToAgent: z.boolean().default(true),
	enabled: z.boolean().default(true)
});
/** schema 默认值（手工构造测试上下文时重读；loader 正常路径会自动应用默认）。 */
const DEFAULT_ANNOUNCE = true;
/**
* 注册公告段落，按组合条目 `announceToAgent`（及 web 设置面服务就绪后的
* 实时设置值）开关。设置变更即重注册，无需重启。
* @param ctx - 插件上下文（已注入 systemPrompt）。
* @param config - 解析后的插件配置（loader 已应用 schema 默认值）。
*/
function apply(ctx, config) {
	ctx.inject(["webServer"], (host) => {
		host.effect(() => mountKeyRoutes(host), "dsh-speech-input: zhipu key routes");
		host.effect(() => mountFunasrTranscribeRoute(host), "dsh-speech-input: funasr transcribe route");
		host.effect(() => mountFunasrLifecycleRoutes(host), "dsh-speech-input: funasr lifecycle route");
	});
	let current = () => config ?? {};
	let disposeSection;
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if ((current().enabled ?? true) === false) return;
		if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === false) return;
		disposeSection = ctx.systemPrompt.section({
			name: "plugin:speech-input",
			order: SECTION_ORDER,
			text: SPEECH_INPUT_GUIDANCE
		});
	};
	installSettingsSection(ctx, SPEECH_INPUT_SETTINGS_NAMESPACE, Config, config ?? {}, {
		setSource: (source) => {
			current = source;
		},
		onChange: sync
	});
	sync();
}
//#endregion
export { Config, FUNASR_START_ROUTE, FUNASR_STATUS_ROUTE, FUNASR_TRANSCRIBE_ROUTE, SPEECH_INPUT_GUIDANCE, SPEECH_INPUT_SETTINGS_NAMESPACE, ZHIPU_KEY_ROUTE, apply, inject };
