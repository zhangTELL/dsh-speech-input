window.__ModuleLoader__.load({
	id: "@dsh-local/dsh-speech-input",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/speech.ts
		/** 智谱语音转写端点（multipart/form-data）。 */
		const ZHIPU_ASR_URL = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";
		/** 智谱 ASR 模型编码。 */
		const ZHIPU_ASR_MODEL = "glm-asr-2512";
		/** 同步接口单段音频时长上限（毫秒）。 */
		const ZHIPU_MAX_DURATION_MS = 3e4;
		/** 识别请求超时（毫秒）。 */
		const ZHIPU_REQUEST_TIMEOUT_MS = 6e4;
		/** 宿主 FunASR 转发路由（浏览器 → DSH host → 本地 FunASR）。 */
		const FUNASR_TRANSCRIBE_ROUTE = "/dsh-speech-input/transcribe";
		/** 本地 FunASR 服务默认地址。 */
		const DEFAULT_FUNASR_URL = "http://127.0.0.1:8000";
		/** 本地 FunASR 默认模型别名。 */
		const DEFAULT_FUNASR_MODEL = "sensevoice";
		/** FunASR 转写请求超时（毫秒）。 */
		const FUNASR_REQUEST_TIMEOUT_MS = 9e4;
		/** FunASR 本地服务无云端时长限制，录音上限放宽到 5 分钟。 */
		const FUNASR_MAX_DURATION_MS = 3e5;
		/** 宿主 FunASR 状态检查路由。 */
		const FUNASR_STATUS_ROUTE = "/dsh-speech-input/funasr/status";
		/** 宿主 FunASR 自动启动路由。 */
		const FUNASR_START_ROUTE = "/dsh-speech-input/funasr/start";
		/** 默认 FunASR 自动启动命令（使用 uv 虚拟环境的 Python）。 */
		const DEFAULT_FUNASR_START_COMMAND = "D:/dsh/FunASR/.venv/Scripts/python.exe server.py --model sensevoice --device cpu --port 8000";
		/** 默认 FunASR 自动启动工作目录。 */
		const DEFAULT_FUNASR_START_CWD = "D:/dsh/FunASR/examples/openai_api";
		/** API Key 的 localStorage 键。 */
		const ZHIPU_KEY_STORAGE_KEY = "dsh.speechInput.zhipuKey";
		/** 智谱 Key 的 host 侧持久化路由（同源相对路径，由宿主插件注册）。 */
		const ZHIPU_KEY_ROUTE = "/dsh-speech-input/key";
		/** 录音最短有效时长（毫秒），短于此视为空输入。 */
		const MIN_VALID_DURATION_MS = 400;
		/** 转写后 WAV 的目标采样率。 */
		const WAV_SAMPLE_RATE = 16e3;
		/**
		* 读取智谱 API Key：优先从 host 持久化文件拉取（跨启动不丢），
		* 拉取失败时回退 localStorage 缓存。
		*/
		async function loadZhipuApiKey() {
			try {
				const response = await fetch(ZHIPU_KEY_ROUTE, {
					method: "GET",
					cache: "no-store"
				});
				if (response.ok) {
					const payload = await response.json();
					const key = typeof payload.key === "string" ? payload.key.trim() : "";
					if (key !== "") {
						try {
							localStorage.setItem(ZHIPU_KEY_STORAGE_KEY, key);
						} catch {}
						return key;
					}
				}
			} catch {}
			try {
				return localStorage.getItem("dsh.speechInput.zhipuKey") ?? "";
			} catch {
				return "";
			}
		}
		/** 同步读取 localStorage 缓存中的 Key（无网络等待，供同步校验使用）。 */
		function loadZhipuApiKeyCached() {
			try {
				return localStorage.getItem("dsh.speechInput.zhipuKey") ?? "";
			} catch {
				return "";
			}
		}
		/** 保存智谱 API Key：写入 host 持久化文件 + localStorage 缓存。 */
		function saveZhipuApiKey(key) {
			const trimmed = key.trim();
			try {
				localStorage.setItem(ZHIPU_KEY_STORAGE_KEY, trimmed);
			} catch {}
			fetch(ZHIPU_KEY_ROUTE, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: trimmed })
			}).catch(() => {});
		}
		/**
		* 当前环境是否支持语音输入。
		*
		* 旧语义为「是否支持 Web Speech API」；新实现以 MediaRecorder +
		* getUserMedia + AudioContext 为准（Electron 渲染进程与 Chrome/Edge 均具备），
		* 函数名保持兼容，UI 无需改动。
		*/
		function isSpeechRecognitionSupported() {
			if (typeof window === "undefined" || typeof navigator === "undefined") return false;
			return typeof navigator.mediaDevices?.getUserMedia === "function" && typeof window.MediaRecorder === "function" && typeof window.AudioContext === "function";
		}
		/** 常见识别错误码 → 中文提示。 */
		const SPEECH_ERROR_MESSAGES = {
			"no-key": "未配置智谱 API Key，请先点击设置按钮填写",
			"mic-denied": "麦克风权限被拒绝，请在系统/应用设置中允许麦克风后重试",
			"audio-capture": "没有检测到可用的麦克风，请检查设备连接",
			"too-long": `单次录音不能超过 ${ZHIPU_MAX_DURATION_MS / 1e3} 秒，请分段录制`,
			"too-large": "录音文件过大（超过 25MB），请分段录制",
			empty: "没有识别到内容，请靠近麦克风再试一次",
			silent: "没有录到任何声音，请检查系统麦克风是否被其他程序占用、或输入设备是否选对",
			"invalid-key": "智谱 API Key 无效或额度不足（401），请检查设置",
			quota: "智谱 API 配额或余额不足，请到控制台查看",
			timeout: "识别请求超时，请检查网络后重试",
			network: "语音服务网络异常，请检查网络后重试",
			aborted: "识别已中断",
			"language-not-supported": "当前语言不受语音服务支持，请在设置中换一种语言",
			"bad-grammar": "语音语法配置错误",
			"funasr-not-configured": "未配置 FunASR 服务地址，请先在设置中填写本地服务地址",
			"funasr-offline": "无法连接本地 FunASR 服务，请确认 FunASR 服务已启动",
			"funasr-http": "FunASR 服务返回异常，请检查模型名称和服务状态",
			"funasr-timeout": "FunASR 转写请求超时，请检查本地服务是否响应",
			"funasr-start-failed": "FunASR 自动启动失败，请检查启动命令和工作目录"
		};
		/** 将识别错误码映射为中文提示。 */
		function speechErrorMessage(error) {
			return SPEECH_ERROR_MESSAGES[error] ?? "语音识别失败，请重试";
		}
		/** 把 PCM 采样编码为 WAV（44 字节头 + 16-bit PCM，单声道）。 */
		function encodeWav(samples, sampleRate) {
			const dataSize = samples.length * 2;
			const buffer = new ArrayBuffer(44 + dataSize);
			const view = new DataView(buffer);
			const writeString = (offset, text) => {
				for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
			};
			writeString(0, "RIFF");
			view.setUint32(4, 36 + dataSize, true);
			writeString(8, "WAVE");
			writeString(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, sampleRate, true);
			view.setUint32(28, sampleRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			writeString(36, "data");
			view.setUint32(40, dataSize, true);
			let offset = 44;
			for (let i = 0; i < samples.length; i++) {
				const s = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
				offset += 2;
			}
			return new Blob([buffer], { type: "audio/wav" });
		}
		/**
		* 复用的解码用 AudioContext。
		*
		* 原因：Chromium 对同一渲染进程可同时存在的 AudioContext 数量有硬上限
		* （约 6 个）。原实现每次录音都 `new AudioContext()`，在 DSH Desktop 这类
		* 长驻页面里，一旦其他模块也持有未释放的 AudioContext，后续录音就会在
		* 构造时抛异常、或拿到不可用的上下文，最终产出全零音频（表现为 FunASR
		* 侧 "empty speech"）。改为单例复用可彻底规避。
		*/
		let sharedDecodeContext = null;
		/** 获取（或重建）解码用的 AudioContext 单例。 */
		function getDecodeContext() {
			if (sharedDecodeContext === null || sharedDecodeContext.state === "closed") sharedDecodeContext = new AudioContext();
			return sharedDecodeContext;
		}
		/**
		* 把 MediaRecorder 产出的 webm/opus blob 重采样为 16kHz 单声道 WAV。
		* 全程浏览器内完成（AudioContext + OfflineAudioContext），无网络依赖。
		*/
		async function webmToWav16k(blob) {
			const arrayBuffer = await blob.arrayBuffer();
			const decoded = await getDecodeContext().decodeAudioData(arrayBuffer);
			const sourceRate = decoded.sampleRate;
			const targetLength = Math.max(1, Math.ceil(decoded.length * (WAV_SAMPLE_RATE / sourceRate)));
			const offline = new OfflineAudioContext(1, targetLength, WAV_SAMPLE_RATE);
			const bufferSource = offline.createBufferSource();
			bufferSource.buffer = decoded;
			bufferSource.connect(offline.destination);
			bufferSource.start(0);
			return encodeWav((await offline.startRendering()).getChannelData(0), WAV_SAMPLE_RATE);
		}
		/**
		* 计算 WAV（16-bit PCM）的归一化峰值。
		*
		* 用于在发送转写请求前识别「录到的是纯静音」：麦克风被系统/其他程序独占、
		* 权限给了空设备、或 AudioContext 异常时都会产出全零采样。此时发请求只会
		* 得到空文本，不如直接给出明确提示。
		*/
		async function wavPeak(wav) {
			const view = new DataView(await wav.arrayBuffer());
			const pcmLength = Math.floor((view.byteLength - 44) / 2);
			if (pcmLength <= 0) return 0;
			let peak = 0;
			for (let i = 0; i < pcmLength; i++) {
				const v = Math.abs(view.getInt16(44 + i * 2, true)) / 32768;
				if (v > peak) peak = v;
			}
			return peak;
		}
		/** 调用智谱 audio/transcriptions，返回转写文本（失败抛出错误码）。 */
		async function transcribeWithZhipu(wav, apiKey) {
			const controller = new AbortController();
			const timer = window.setTimeout(() => controller.abort(), ZHIPU_REQUEST_TIMEOUT_MS);
			try {
				const form = new FormData();
				form.append("model", ZHIPU_ASR_MODEL);
				form.append("file", wav, "speech.wav");
				const response = await fetch(ZHIPU_ASR_URL, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}` },
					body: form,
					signal: controller.signal
				});
				if (!response.ok) {
					if (response.status === 401 || response.status === 403) throw new Error("invalid-key");
					if (response.status === 402 || response.status === 429) throw new Error("quota");
					if (response.status === 413) throw new Error("too-large");
					throw new Error("network");
				}
				const payload = await response.json();
				if (typeof payload.text !== "string") throw new Error(payload.error?.message ? "network" : "network");
				return payload.text;
			} catch (error) {
				if (error instanceof Error && error.message === "aborted") throw new Error("aborted");
				if (error instanceof DOMException && error.name === "AbortError") throw new Error("timeout");
				throw error;
			} finally {
				window.clearTimeout(timer);
			}
		}
		/** 等待指定毫秒。 */
		function sleep(ms) {
			return new Promise((resolve) => window.setTimeout(resolve, ms));
		}
		/** 查询宿主侧 FunASR 服务是否已就绪。 */
		async function fetchFunasrStatus(baseUrl) {
			try {
				const endpoint = new URL(FUNASR_STATUS_ROUTE, window.location.origin);
				endpoint.searchParams.set("url", baseUrl.trim());
				const response = await fetch(endpoint.toString(), { cache: "no-store" });
				if (!response.ok) return false;
				return (await response.json()).running === true;
			} catch {
				return false;
			}
		}
		/** 请求宿主启动本地 FunASR 服务。 */
		async function requestFunasrStart(baseUrl, model, startCommand, startCwd) {
			const endpoint = new URL(FUNASR_START_ROUTE, window.location.origin);
			endpoint.searchParams.set("url", baseUrl.trim());
			endpoint.searchParams.set("model", model.trim() || "sensevoice");
			endpoint.searchParams.set("command", startCommand.trim());
			endpoint.searchParams.set("cwd", startCwd.trim());
			let response;
			try {
				response = await fetch(endpoint.toString(), {
					method: "POST",
					cache: "no-store"
				});
			} catch {
				throw new Error("funasr-offline");
			}
			let payload = {};
			try {
				payload = await response.json();
			} catch {}
			if (!response.ok || payload.error) {
				if (payload.error === "no-command") throw new Error("funasr-not-configured");
				throw new Error(payload.error || "funasr-start-failed");
			}
		}
		/**
		* 在 FunASR 模式下开始转写前确保本地服务已启动。
		* 若用户关闭自动启动，则不做任何操作，直接尝试连接现有服务。
		*/
		async function ensureFunasrStarted(options) {
			if (!options.funasrAutoStart) return;
			if (await fetchFunasrStatus(options.funasrUrl)) return;
			await requestFunasrStart(options.funasrUrl, options.funasrModel, options.funasrStartCommand, options.funasrStartCwd);
			const deadline = Date.now() + 3e4;
			while (Date.now() < deadline) {
				if (await fetchFunasrStatus(options.funasrUrl)) return;
				await sleep(500);
			}
		}
		/**
		* 调用 DSH 宿主转写路由，由宿主转发到本地 FunASR OpenAI 兼容服务。
		* @param wav - 16kHz 单声道 WAV。
		* @param baseUrl - FunASR 服务基础地址，如 http://127.0.0.1:8000。
		* @param model - FunASR 模型别名，如 sensevoice / paraformer。
		* @param idleMinutes - 闲置多少分钟后由宿主回收自动启动的服务；0 表示常驻。
		* @returns 转写文本；失败抛出错误码。
		*/
		async function transcribeWithFunasr(wav, baseUrl, model, idleMinutes) {
			const controller = new AbortController();
			const timer = window.setTimeout(() => controller.abort(), FUNASR_REQUEST_TIMEOUT_MS);
			try {
				const endpoint = new URL(FUNASR_TRANSCRIBE_ROUTE, window.location.origin);
				endpoint.searchParams.set("url", baseUrl.trim());
				endpoint.searchParams.set("model", model.trim() || "sensevoice");
				endpoint.searchParams.set("idle", String(idleMinutes));
				const response = await fetch(endpoint.toString(), {
					method: "POST",
					headers: { "content-type": "audio/wav" },
					body: wav,
					signal: controller.signal
				});
				if (!response.ok) {
					let code = "funasr-http";
					try {
						const payload = await response.json();
						if (typeof payload.error === "string" && payload.error !== "") code = payload.error;
					} catch {}
					throw new Error(code);
				}
				const payload = await response.json();
				if (typeof payload.text !== "string") throw new Error(payload.error || "funasr-http");
				return payload.text;
			} catch (error) {
				if (error instanceof Error && error.message === "aborted") throw new Error("aborted");
				if (error instanceof DOMException && error.name === "AbortError") throw new Error("funasr-timeout");
				if (error instanceof TypeError) throw new Error("funasr-offline");
				throw error;
			} finally {
				window.clearTimeout(timer);
			}
		}
		/**
		* 录音 + 转写识别器：点击/长按开始录音，手动停止（或 30s 自动截断）后
		* 转 16kHz WAV，再按所选引擎（FunASR 本地 / 智谱云端）完成转写，
		* 完成后经 onUpdate/onSettled 回传。同一时刻只允许一个活动实例。
		*/
		var SpeechRecognizer = class {
			options;
			handlers;
			stream = null;
			recorder = null;
			chunks = [];
			startedAt = 0;
			stopping = false;
			aborted = false;
			pendingStop = false;
			durationTimer;
			/**
			* 构造识别器。若环境不支持录音会直接抛出（调用方应先做能力检测）。
			* @param options - 兼容字段（lang/continuous/interimResults 保留但不再影响行为）。
			* @param handlers - 事件回调。
			*/
			constructor(options, handlers) {
				this.options = options;
				this.handlers = handlers;
				if (!isSpeechRecognitionSupported()) throw new Error("speech input is not supported");
			}
			/**
			* 开始录音。返回 false 表示启动失败（权限被拒 / 无麦克风 / 未配置 Key）。
			* Key 缺失时通过 onStatus('error') 给出中文提示。
			*/
			start() {
				if (this.options.engine === "zhipu" && loadZhipuApiKeyCached() === "") {
					this.handlers.onStatus("error", speechErrorMessage("no-key"));
					return false;
				}
				if (this.options.engine === "funasr" && this.options.funasrUrl.trim() === "") {
					this.handlers.onStatus("error", speechErrorMessage("funasr-not-configured"));
					return false;
				}
				if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
					this.handlers.onStatus("error", speechErrorMessage("audio-capture"));
					return false;
				}
				this.beginCapture();
				return true;
			}
			/**
			* 打开麦克风。
			*
			* 显式关闭回声消除/噪声抑制/自动增益：这三者是为通话场景设计的，在部分
			* Windows 声卡驱动上会把麦克风输入整体压成静音（表现为转写恒为空）。STT
			* 场景应拿原始信号。若设备不接受这些约束，退回 `{ audio: true }`。
			*/
			async openMicStream() {
				try {
					return await navigator.mediaDevices.getUserMedia({ audio: {
						echoCancellation: false,
						noiseSuppression: false,
						autoGainControl: false,
						channelCount: 1
					} });
				} catch {
					return await navigator.mediaDevices.getUserMedia({ audio: true });
				}
			}
			/** 录音并启动识别器（异步：先等麦克风授权）。 */
			async beginCapture() {
				try {
					this.stream = await this.openMicStream();
				} catch {
					this.handlers.onStatus("error", speechErrorMessage("mic-denied"));
					return;
				}
				if (this.aborted) {
					this.teardownStream();
					return;
				}
				let mimeType = "audio/webm;codecs=opus";
				if (typeof window.MediaRecorder === "undefined") {
					this.handlers.onStatus("error", speechErrorMessage("audio-capture"));
					this.teardownStream();
					return;
				}
				if (!window.MediaRecorder.isTypeSupported(mimeType)) mimeType = "audio/webm";
				try {
					this.recorder = new MediaRecorder(this.stream, { mimeType });
				} catch {
					this.recorder = new MediaRecorder(this.stream);
				}
				this.chunks = [];
				this.stopping = false;
				this.startedAt = Date.now();
				this.recorder.ondataavailable = (event) => {
					if (event.data.size > 0) this.chunks.push(event.data);
				};
				this.recorder.onstop = () => {
					this.finishCapture();
				};
				this.recorder.start();
				this.handlers.onStatus("listening");
				if (this.pendingStop) {
					this.pendingStop = false;
					this.stopRecorder();
					return;
				}
				this.durationTimer = window.setTimeout(() => {
					if (this.recorder !== null && this.recorder.state !== "inactive" && !this.stopping) {
						this.stopping = true;
						this.recorder.stop();
					}
				}, this.maxDurationMs());
			}
			/** 单次录音时长上限：智谱云端 30 秒，本地 FunASR 放宽到 5 分钟。 */
			maxDurationMs() {
				return this.options.engine === "funasr" ? FUNASR_MAX_DURATION_MS : ZHIPU_MAX_DURATION_MS;
			}
			/** 停止录音器（若已创建且仍在运行）。 */
			stopRecorder() {
				const recorder = this.recorder;
				if (recorder === null || recorder.state === "inactive") return;
				try {
					recorder.stop();
				} catch {}
			}
			/** 录音结束：收拢音频、转 WAV、调用智谱、回传结果。 */
			async finishCapture() {
				if (this.durationTimer !== void 0) {
					window.clearTimeout(this.durationTimer);
					this.durationTimer = void 0;
				}
				const recorder = this.recorder;
				this.recorder = null;
				this.teardownStream();
				if (this.aborted) return;
				const elapsed = Date.now() - this.startedAt;
				const recording = new Blob(this.chunks, { type: recorder?.mimeType ?? "audio/webm" });
				if (elapsed < MIN_VALID_DURATION_MS || recording.size === 0) {
					this.handlers.onUpdate("", "");
					this.handlers.onSettled("");
					return;
				}
				if (this.options.engine !== "funasr" && elapsed > 31e3) {
					this.handlers.onStatus("error", speechErrorMessage("too-long"));
					return;
				}
				try {
					const wav = await webmToWav16k(recording);
					if (wav.size > 26214400) {
						this.handlers.onStatus("error", speechErrorMessage("too-large"));
						return;
					}
					if (await wavPeak(wav) < .001) {
						this.handlers.onStatus("error", speechErrorMessage("silent"));
						return;
					}
					this.handlers.onStatus("transcribing");
					if (this.options.engine === "funasr") await ensureFunasrStarted(this.options);
					const text = this.options.engine === "funasr" ? (await transcribeWithFunasr(wav, this.options.funasrUrl, this.options.funasrModel, this.options.funasrIdleMinutes)).trim() : (await transcribeWithZhipu(wav, loadZhipuApiKeyCached())).trim();
					this.handlers.onUpdate(text, "");
					this.handlers.onSettled(text);
				} catch (error) {
					const code = error instanceof Error ? error.message : "network";
					if (code === "aborted") {
						this.handlers.onSettled("");
						return;
					}
					this.handlers.onStatus("error", speechErrorMessage(code));
				}
			}
			/** 请求停止：停止录音并触发转写收尾。 */
			stop() {
				if (this.stopping) return;
				this.stopping = true;
				if (this.recorder === null) {
					this.pendingStop = true;
					return;
				}
				this.stopRecorder();
			}
			/** 立即中断（如组件卸载），不触发转写。 */
			abort() {
				this.aborted = true;
				this.stopping = true;
				if (this.durationTimer !== void 0) {
					window.clearTimeout(this.durationTimer);
					this.durationTimer = void 0;
				}
				try {
					if (this.recorder !== null && this.recorder.state !== "inactive") this.recorder.stop();
				} catch {}
				this.teardownStream();
			}
			/** 释放麦克风轨道。 */
			teardownStream() {
				this.stream?.getTracks().forEach((track) => track.stop());
				this.stream = null;
			}
		};
		//#endregion
		//#region src/client/settings.ts
		/**
		* 语音输入偏好与界面文案（简体中文，跟随全局偏好）。
		*
		* 偏好存浏览器 localStorage（键 dsh.speechInput.v1），不依赖宿主设置面，
		* 保持浏览器侧完全自包含；识别引擎、FunASR 服务地址/模型、插入模式、
		* 长按空格四项可配，另记忆最后一次使用的语言。
		*
		* 说明（2026-09 改为双引擎后）：
		*  - `engine` 可选 `funasr`（本地 FunASR OpenAI 兼容服务）或 `zhipu`（智谱云端）；
		*  - 语言由模型自动检测，`lang` 字段仅保留兼容旧数据，设置界面不再展示；
		*  - `continuous` / `interimFeedback` 同理保留兼容，不再影响行为；
		*  - 智谱 API Key 单独存 localStorage（键 dsh.speechInput.zhipuKey）。
		*/
		/** 默认偏好（与宿主 schema 无关，纯浏览器侧）。 */
		const DEFAULT_PREFERENCES = {
			lang: "zh-CN",
			insertMode: "append",
			continuous: true,
			interimFeedback: true,
			pttEnabled: true,
			engine: "funasr",
			funasrUrl: DEFAULT_FUNASR_URL,
			funasrModel: DEFAULT_FUNASR_MODEL,
			funasrAutoStart: true,
			funasrStartCommand: DEFAULT_FUNASR_START_COMMAND,
			funasrStartCwd: DEFAULT_FUNASR_START_CWD,
			funasrIdleMinutes: 10
		};
		/** localStorage 键。 */
		const PREFS_KEY = "dsh.speechInput.v1";
		/** 读取偏好；损坏或缺失时回退默认值。 */
		function loadPreferences() {
			try {
				const raw = localStorage.getItem(PREFS_KEY);
				if (raw === null) return { ...DEFAULT_PREFERENCES };
				const parsed = JSON.parse(raw);
				const lang = typeof parsed.lang === "string" && parsed.lang !== "" ? parsed.lang : DEFAULT_PREFERENCES.lang;
				const insertMode = parsed.insertMode === "replace" ? "replace" : "append";
				const engine = parsed.engine === "zhipu" ? "zhipu" : "funasr";
				const funasrUrl = typeof parsed.funasrUrl === "string" && parsed.funasrUrl.trim() !== "" ? parsed.funasrUrl.trim() : DEFAULT_FUNASR_URL;
				const funasrModel = typeof parsed.funasrModel === "string" && parsed.funasrModel.trim() !== "" ? parsed.funasrModel.trim() : DEFAULT_FUNASR_MODEL;
				const funasrAutoStart = parsed.funasrAutoStart !== false;
				const funasrIdleMinutes = Number.isFinite(parsed.funasrIdleMinutes) ? Math.max(0, Math.min(480, Math.trunc(parsed.funasrIdleMinutes))) : 10;
				const funasrStartCommand = typeof parsed.funasrStartCommand === "string" ? parsed.funasrStartCommand === "python server.py --model sensevoice --device cpu --port 8000" ? DEFAULT_FUNASR_START_COMMAND : parsed.funasrStartCommand : DEFAULT_FUNASR_START_COMMAND;
				const funasrStartCwd = typeof parsed.funasrStartCwd === "string" && parsed.funasrStartCwd.trim() !== "" ? parsed.funasrStartCwd.trim() : DEFAULT_FUNASR_START_CWD;
				return {
					lang,
					insertMode,
					continuous: parsed.continuous === false ? false : true,
					interimFeedback: parsed.interimFeedback === false ? false : true,
					pttEnabled: parsed.pttEnabled === false ? false : true,
					engine,
					funasrUrl,
					funasrModel,
					funasrAutoStart,
					funasrStartCommand,
					funasrStartCwd,
					funasrIdleMinutes
				};
			} catch {
				return { ...DEFAULT_PREFERENCES };
			}
		}
		/** 保存偏好（隐私模式等异常静默忽略）。 */
		function savePreferences(prefs) {
			try {
				localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
			} catch {}
		}
		const UI_COPY = {
			tooltipIdle: "语音输入（点击开始；长按空格键说话）",
			tooltipListening: "录音中…（点击停止）",
			tooltipUnsupported: "当前环境不支持录音，请使用 Chrome / Edge / DSH Desktop",
			settingsTitle: "语音输入设置",
			settingsDescription: "选择本地 FunASR 或智谱云端作为语音转写引擎；单次录音最长 30 秒",
			settingsEngine: "识别引擎",
			engineFunasr: "本地 FunASR",
			engineFunasrDesc: "通过本机 FunASR OpenAI 兼容服务转写，音频不出本机",
			engineZhipu: "智谱云端",
			engineZhipuDesc: "使用智谱 GLM-ASR 云端转写，需要 API Key，音频会发送到智谱",
			settingsFunasrUrl: "FunASR 服务地址",
			settingsFunasrUrlPlaceholder: "http://127.0.0.1:8000",
			settingsFunasrUrlHint: "需要先启动本地 FunASR 服务（如 python server.py --model sensevoice --device cpu --port 8000）",
			settingsFunasrModel: "FunASR 模型",
			settingsFunasrModelPlaceholder: "sensevoice / paraformer / paraformer-en / fun-asr-nano",
			settingsFunasrModelHint: "默认 sensevoice，支持中文、英文、日文、韩文和粤语",
			settingsFunasrAutoStart: "切换/开始录音时自动启动 FunASR 服务",
			settingsFunasrStartCommand: "FunASR 启动命令",
			settingsFunasrStartCommandPlaceholder: "D:/dsh/FunASR/.venv/Scripts/python.exe server.py --model sensevoice --device cpu --port 8000",
			settingsFunasrStartCommandHint: "留空则不会自动启动；仍可通过服务地址直连已运行的服务",
			settingsFunasrStartCwd: "启动命令工作目录",
			settingsFunasrStartCwdPlaceholder: "D:/dsh/FunASR/examples/openai_api",
			settingsFunasrStartCwdHint: "如果 server.py 不在 DSH 当前目录，请填写 FunASR 示例服务所在目录",
			settingsFunasrIdleMinutes: "闲置自动退出",
			settingsFunasrIdleNever: "永不退出（常驻）",
			settingsFunasrIdleMinutesOption: "闲置 {n} 分钟后退出",
			settingsFunasrIdleMinutesHint: "常驻约占 2.8 GB 内存；退出后下次说话会重新拉起（有冷启动延迟）。只对插件自动启动的服务生效",
			settingsApiKey: "智谱 API Key",
			settingsApiKeyPlaceholder: "粘贴智谱开放平台 API Key（open.bigmodel.cn）",
			settingsApiKeyHint: "Key 保存在本机（DSH 配置目录，重启不丢失）；识别音频会发送给智谱服务",
			settingsInsertMode: "识别结果插入方式",
			settingsInsertAppend: "插入到光标所在位置",
			settingsInsertReplace: "替换输入框内容",
			settingsPtt: "长按空格键说话（松开停止；短按输入空格）",
			close: "完成",
			listeningBadge: "录音中…",
			transcribingBadge: "转写中…",
			restartHint: "设置将自动保存并在下次录音时生效"
		};
		//#endregion
		//#region src/client/SpeechInputButton.tsx
		/**
		* 语音输入按钮组（composer 右下角「conversation.input.right」席位）。
		*
		* 两个按钮：麦克风（点击开始/停止浏览器语音识别，实时把语音转成文字写入
		* 草稿）与设置（识别语言、插入模式、连续识别等偏好，存 localStorage）。
		* 识别失败/权限被拒时在按钮上方弹出错误浮条；浏览器不支持 Web Speech API
		* 时按钮禁用并给出换浏览器提示。组件只读草稿，写入一律走 inputActions。
		*/
		/** 脉冲动画 keyframes（只注入一次，用数据属性做 CSS 变量传值）。 */
		const PULSE_KEYFRAMES = `
@keyframes dsh-speech-input-pulse {
  0% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.45); }
  70% { box-shadow: 0 0 0 9px rgba(229, 72, 77, 0); }
  100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0); }
}
`;
		/** 麦克风内联图标（stroke 风格，跟随 currentColor）。 */
		function MicIcon({ size = 14 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "5.8",
						y: "2.4",
						width: "4.4",
						height: "7.4",
						rx: "2.2"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 7.6a4 4 0 0 0 8 0" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 11.6v2.2" })
				]
			});
		}
		/** 设置项按钮的基础样式。 */
		const optionButtonBase$1 = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			minWidth: 0,
			padding: "7px 10px",
			borderRadius: 10,
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			font: "inherit",
			fontSize: 13,
			lineHeight: 1.3,
			textAlign: "left"
		};
		/** 设置项按钮选中态样式。 */
		const optionButtonSelected$1 = {
			borderColor: "var(--dsw-alias-state-business-primary)",
			background: "var(--dsw-alias-state-business-tertiary)",
			color: "var(--dsw-alias-label-primary-bluish)"
		};
		/** 元素是否为可读光标位置的输入框（DSH composer 是 textarea）。 */
		function isEditable(el) {
			return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
		}
		/** 在草稿 [start, end) 处替换为 body 的合成文本。 */
		function spliceDraft(draft, start, end, body) {
			return draft.slice(0, start) + body + draft.slice(end);
		}
		/** 识别结束后异步恢复焦点与光标（等 React 完成 setDraft 渲染）。 */
		function restoreCaret(el, pos) {
			if (el === null) return;
			window.setTimeout(() => {
				if (!el.isConnected) return;
				el.focus();
				if (isEditable(el)) try {
					el.setSelectionRange(pos, pos);
				} catch {}
			}, 0);
		}
		function captureInsertPoint(fallback) {
			const el = document.activeElement;
			if (isEditable(el) && el.selectionStart !== null && el.selectionEnd !== null) return {
				el,
				start: el.selectionStart,
				end: el.selectionEnd
			};
			return {
				el: null,
				start: fallback,
				end: fallback
			};
		}
		function SpeechInputButton(props) {
			const { useInput, inputActions } = props;
			const copy = UI_COPY;
			const [prefs, setPrefs] = (0, react.useState)(() => loadPreferences());
			const [listening, setListening] = (0, react.useState)(false);
			const [transcribing, setTranscribing] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [settingsOpen, setSettingsOpen] = (0, react.useState)(false);
			const supported = isSpeechRecognitionSupported();
			const [zhipuKey, setZhipuKey] = (0, react.useState)(() => loadZhipuApiKeyCached());
			const draft = useInput?.((s) => s.draft) ?? "";
			const draftRef = (0, react.useRef)(draft);
			draftRef.current = draft;
			const recognizerRef = (0, react.useRef)(null);
			const baseRef = (0, react.useRef)("");
			const finalRef = (0, react.useRef)("");
			const errorTimerRef = (0, react.useRef)(void 0);
			/** 本次识别的插入点（识别开始时捕捉的光标位置；append 模式使用）。 */
			const insertPointRef = (0, react.useRef)(null);
			if (inputActions === void 0) return null;
			/**
			* 把「定稿文本 + 中间文本」写入草稿：replace 整体替换；
			* append 插入到识别开始时的光标位置（无光标信息则追加末尾）。
			*/
			const renderDraft = (0, react.useCallback)((finalText, interimText) => {
				const body = finalText + interimText;
				if (prefs.insertMode === "replace") {
					inputActions.setDraft(body);
					return;
				}
				const point = insertPointRef.current;
				const start = point?.start ?? baseRef.current.length;
				const end = point?.end ?? start;
				const next = spliceDraft(baseRef.current, start, end, body);
				inputActions.setDraft(next);
				if (point?.el !== null && point !== null) restoreCaret(point.el, start + body.length);
			}, [prefs.insertMode, inputActions]);
			/**
			* 停止当前识别（如果有）。UI 状态立即复位，但**不**清空
			* recognizerRef：识别器引用要等 onend（onSettled）真正结束才清空。
			* 若在 stop() 之前就清掉引用，用户可立刻启动新一轮识别，而旧识别器
			* 的收尾回调（onend → onSettled → renderDraft）还没执行完，两个
			* 识别器会先后把结果写入草稿，append 模式下出现「你好你好」式重复。
			*/
			const stopListening = (0, react.useCallback)(() => {
				const recognizer = recognizerRef.current;
				if (recognizer === null) return;
				setListening(false);
				recognizer.stop();
			}, []);
			/** 启动一轮识别。 */
			const startListening = (0, react.useCallback)(() => {
				if (recognizerRef.current !== null) return;
				setError(null);
				setTranscribing(false);
				baseRef.current = draftRef.current;
				finalRef.current = "";
				insertPointRef.current = captureInsertPoint(draftRef.current.length);
				const recognizer = new SpeechRecognizer({
					lang: prefs.lang,
					continuous: prefs.continuous,
					interimResults: prefs.interimFeedback,
					engine: prefs.engine,
					funasrUrl: prefs.funasrUrl,
					funasrModel: prefs.funasrModel,
					funasrAutoStart: prefs.funasrAutoStart,
					funasrStartCommand: prefs.funasrStartCommand,
					funasrStartCwd: prefs.funasrStartCwd,
					funasrIdleMinutes: prefs.funasrIdleMinutes
				}, {
					onUpdate: (finalText, interimText) => {
						finalRef.current = finalText;
						renderDraft(finalText, interimText);
					},
					onSettled: (text) => {
						setListening(false);
						setTranscribing(false);
						recognizerRef.current = null;
						if (prefs.insertMode === "replace" && text === "") {
							inputActions.setDraft(baseRef.current);
							insertPointRef.current = null;
							return;
						}
						renderDraft(text, "");
						insertPointRef.current = null;
					},
					onStatus: (status, message) => {
						if (status === "listening") {
							setListening(true);
							return;
						}
						if (status === "transcribing") {
							setListening(false);
							setTranscribing(true);
							return;
						}
						if (status === "error") {
							setListening(false);
							setTranscribing(false);
							recognizerRef.current = null;
							if (prefs.insertMode === "replace") inputActions.setDraft(baseRef.current);
							else renderDraft(finalRef.current, "");
							setError(message ?? copy.restartHint);
						}
					}
				});
				recognizerRef.current = recognizer;
				if (!recognizer.start()) {
					recognizerRef.current = null;
					setError(copy.restartHint);
				}
			}, [
				prefs,
				renderDraft,
				inputActions,
				copy.restartHint
			]);
			/** 主按钮点击：切换识别（以识别器引用为权威判断，防 state 不同步卡死）。 */
			const toggleListening = (0, react.useCallback)(() => {
				if (listening || recognizerRef.current !== null) stopListening();
				else startListening();
			}, [
				listening,
				stopListening,
				startListening
			]);
			/** 错误浮条自动消失。 */
			(0, react.useEffect)(() => {
				if (error === null) return;
				errorTimerRef.current = window.setTimeout(() => setError(null), 3800);
				return () => {
					if (errorTimerRef.current !== void 0) window.clearTimeout(errorTimerRef.current);
				};
			}, [error]);
			/** 挂载时从 host 拉取持久化的智谱 API Key（覆盖 localStorage 缓存）。 */
			(0, react.useEffect)(() => {
				let cancelled = false;
				loadZhipuApiKey().then((remoteKey) => {
					if (cancelled || remoteKey === "") return;
					setZhipuKey(remoteKey);
					saveZhipuApiKey(remoteKey);
				});
				return () => {
					cancelled = true;
				};
			}, []);
			/** 组件卸载时中断识别。 */
			(0, react.useEffect)(() => () => {
				recognizerRef.current?.abort();
				recognizerRef.current = null;
			}, []);
			/**
			* 长按空格说话（Push-to-Talk）：keydown 空格先拦截默认（空格输入/页面
			* 滚动）并启动长按定时器；300ms 内松开（短按）→ 在光标处补一个空格，
			* 恢复打字语义；超过 300ms（长按）→ 开始识别，松开时停止。细节：
			*  - 输入法组合输入中（isComposing）不拦截，避免干扰中文选字；
			*  - 长按期间的自动重复 keydown（e.repeat）继续阻止默认，光标不乱跑；
			*  - 识别已在运行（如按钮启动）时空格不接管，松开也不会误停；
			*  - 用 ref 转发最新回调，避免 effect 闭包过期。
			*/
			const PTT_LONG_PRESS_MS = 300;
			const startRef = (0, react.useRef)(startListening);
			startRef.current = startListening;
			const stopRef = (0, react.useRef)(stopListening);
			stopRef.current = stopListening;
			const pttActiveRef = (0, react.useRef)(false);
			const pttTimerRef = (0, react.useRef)(void 0);
			/** 在光标处插入文本（短按空格补空格；无输入框焦点则不做）。 */
			const insertAtCaret = (0, react.useCallback)((text) => {
				const el = document.activeElement;
				if (!isEditable(el) || el.selectionStart === null || el.selectionEnd === null) return;
				const start = el.selectionStart;
				const end = el.selectionEnd;
				inputActions.setDraft(spliceDraft(draftRef.current, start, end, text));
				restoreCaret(el, start + text.length);
			}, [inputActions]);
			const insertAtCaretRef = (0, react.useRef)(insertAtCaret);
			insertAtCaretRef.current = insertAtCaret;
			(0, react.useEffect)(() => {
				if (!supported || !prefs.pttEnabled) return;
				const onKeyDown = (event) => {
					if (event.code !== "Space" || event.isComposing) return;
					if (event.repeat) {
						event.preventDefault();
						return;
					}
					if (recognizerRef.current !== null) return;
					event.preventDefault();
					if (pttTimerRef.current !== void 0) return;
					pttTimerRef.current = window.setTimeout(() => {
						pttTimerRef.current = void 0;
						pttActiveRef.current = true;
						startRef.current();
					}, PTT_LONG_PRESS_MS);
				};
				const onKeyUp = (event) => {
					if (event.code !== "Space") return;
					if (pttActiveRef.current) {
						pttActiveRef.current = false;
						stopRef.current();
						return;
					}
					if (pttTimerRef.current !== void 0) {
						window.clearTimeout(pttTimerRef.current);
						pttTimerRef.current = void 0;
						insertAtCaretRef.current(" ");
					}
				};
				window.addEventListener("keydown", onKeyDown);
				window.addEventListener("keyup", onKeyUp);
				return () => {
					if (pttTimerRef.current !== void 0) window.clearTimeout(pttTimerRef.current);
					window.removeEventListener("keydown", onKeyDown);
					window.removeEventListener("keyup", onKeyUp);
				};
			}, [supported, prefs.pttEnabled]);
			/** 保存偏好；若正在识别先收尾（避免模式中途切换）。 */
			const applyPrefs = (0, react.useCallback)((next) => {
				setPrefs(next);
				savePreferences(next);
				if (listening) stopListening();
			}, [listening, stopListening]);
			/** 保存智谱 API Key（输入即存，本地浏览器）。 */
			const applyZhipuKey = (0, react.useCallback)((key) => {
				setZhipuKey(key);
				saveZhipuApiKey(key);
			}, []);
			/** 打开设置对话框时若在识别，先停止。 */
			const openSettings = (0, react.useCallback)(() => {
				if (listening) stopListening();
				setSettingsOpen(true);
			}, [listening, stopListening]);
			const micButtonStyle = {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: 28,
				height: 28,
				padding: 0,
				borderRadius: 8,
				border: "none",
				background: listening ? "rgba(229, 72, 77, 0.16)" : "transparent",
				color: listening ? "#e5484d" : "var(--dsw-alias-label-tertiary)",
				cursor: supported ? "pointer" : "not-allowed",
				animation: listening ? "dsh-speech-input-pulse 1.6s ease-out infinite" : void 0,
				flexShrink: 0
			};
			/** 状态/错误提示浮条（挂在 28px 宽的按钮容器上）。
			* 坑 1：absolute 元素默认 shrink-to-fit，可用宽度受包含块（28px）限制，
			*       文字会竖着换行 —— 必须显式 width: 'max-content'。
			* 坑 2：主题变量组合不可靠 —— 浅色主题下 label-primary 是深色字，而
			*       surface-raised 可能未定义（回退深色），组成黑底黑字。
			*       浮条是临时提示，直接用固定深底浅字保证对比度。 */
			const badgeStyle = {
				position: "absolute",
				right: 0,
				bottom: "calc(100% + 8px)",
				zIndex: 30,
				width: "max-content",
				maxWidth: 280,
				padding: "8px 12px",
				borderRadius: 8,
				background: "rgba(28, 32, 44, 0.96)",
				color: "#f2f4f8",
				border: "1px solid rgba(229, 72, 77, 0.45)",
				borderLeft: "3px solid #e5484d",
				boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
				fontSize: 12.5,
				fontWeight: 500,
				lineHeight: 1.5,
				whiteSpace: "normal",
				wordBreak: "break-word",
				pointerEvents: "none"
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: PULSE_KEYFRAMES }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						position: "relative",
						display: "inline-flex",
						alignItems: "center",
						gap: 2
					},
					children: [
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: badgeStyle,
							role: "alert",
							children: error
						}),
						error === null && listening && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...badgeStyle,
								borderColor: "rgba(229, 72, 77, 0.45)",
								borderLeftColor: "#e5484d"
							},
							role: "status",
							children: copy.listeningBadge
						}),
						error === null && !listening && transcribing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...badgeStyle,
								borderColor: "rgba(255, 255, 255, 0.14)",
								borderLeftColor: "#8a919e"
							},
							role: "status",
							children: copy.transcribingBadge
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: "语音输入设置",
							side: "bottom",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-label": "语音输入设置",
								"aria-haspopup": "dialog",
								"aria-expanded": settingsOpen,
								onClick: openSettings,
								style: {
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									width: 28,
									height: 28,
									padding: 0,
									borderRadius: 8,
									border: "none",
									background: "transparent",
									color: "var(--dsw-alias-label-tertiary)",
									cursor: "pointer",
									flexShrink: 0
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline14, { size: 14 })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: supported ? listening ? copy.tooltipListening : copy.tooltipIdle : copy.tooltipUnsupported,
							side: "bottom",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-label": supported ? listening ? copy.tooltipListening : copy.tooltipIdle : copy.tooltipUnsupported,
								"aria-pressed": listening,
								disabled: !supported,
								onClick: toggleListening,
								style: micButtonStyle,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, { size: 18 })
							})
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
					open: settingsOpen,
					onClose: () => setSettingsOpen(false),
					title: copy.settingsTitle,
					closeLabel: copy.close,
					description: copy.settingsDescription,
					footer: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						size: "sm",
						onClick: () => setSettingsOpen(false),
						children: copy.close
					}),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 16,
							maxHeight: "min(60vh, 520px)",
							overflowY: "auto",
							paddingRight: 6,
							overscrollBehavior: "contain"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 8
								},
								children: copy.settingsEngine
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 6
								},
								children: [[
									"funasr",
									copy.engineFunasr,
									copy.engineFunasrDesc
								], [
									"zhipu",
									copy.engineZhipu,
									copy.engineZhipuDesc
								]].map(([engine, label, desc]) => {
									const active = prefs.engine === engine;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										onClick: () => {
											const next = {
												...prefs,
												engine
											};
											applyPrefs(next);
											if (engine === "funasr" && next.funasrAutoStart) ensureFunasrStarted(next);
										},
										style: {
											...optionButtonBase$1,
											...active ? optionButtonSelected$1 : null
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: { fontWeight: 500 },
												children: label
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													marginLeft: "auto",
													fontSize: 12,
													color: "var(--dsw-alias-label-tertiary)"
												},
												children: desc
											}),
											active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 14 })
										]
									}, engine);
								})
							})] }),
							prefs.engine === "funasr" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 13,
											fontWeight: 600,
											marginBottom: 8
										},
										children: copy.settingsFunasrUrl
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "text",
										value: prefs.funasrUrl,
										placeholder: copy.settingsFunasrUrlPlaceholder,
										onChange: (event) => applyPrefs({
											...prefs,
											funasrUrl: event.target.value
										}),
										spellCheck: false,
										autoComplete: "off",
										style: {
											width: "100%",
											padding: "8px 10px",
											borderRadius: 8,
											border: "1px solid var(--dsw-alias-border-l1)",
											background: "var(--dsw-alias-surface-raised)",
											color: "var(--dsw-alias-label-primary)",
											font: "inherit",
											fontSize: 13
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											lineHeight: 1.6,
											color: "var(--dsw-alias-label-tertiary)",
											marginTop: 6
										},
										children: copy.settingsFunasrUrlHint
									})
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 13,
											fontWeight: 600,
											marginBottom: 8
										},
										children: copy.settingsFunasrModel
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "text",
										value: prefs.funasrModel,
										placeholder: copy.settingsFunasrModelPlaceholder,
										onChange: (event) => applyPrefs({
											...prefs,
											funasrModel: event.target.value
										}),
										spellCheck: false,
										autoComplete: "off",
										style: {
											width: "100%",
											padding: "8px 10px",
											borderRadius: 8,
											border: "1px solid var(--dsw-alias-border-l1)",
											background: "var(--dsw-alias-surface-raised)",
											color: "var(--dsw-alias-label-primary)",
											font: "inherit",
											fontSize: 13
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											lineHeight: 1.6,
											color: "var(--dsw-alias-label-tertiary)",
											marginTop: 6
										},
										children: copy.settingsFunasrModelHint
									})
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 8,
										cursor: "pointer",
										fontSize: 13
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: prefs.funasrAutoStart,
										onChange: (event) => applyPrefs({
											...prefs,
											funasrAutoStart: event.target.checked
										})
									}), copy.settingsFunasrAutoStart]
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 13,
											fontWeight: 600,
											marginBottom: 8
										},
										children: copy.settingsFunasrStartCommand
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "text",
										value: prefs.funasrStartCommand,
										placeholder: copy.settingsFunasrStartCommandPlaceholder,
										onChange: (event) => applyPrefs({
											...prefs,
											funasrStartCommand: event.target.value
										}),
										spellCheck: false,
										autoComplete: "off",
										style: {
											width: "100%",
											padding: "8px 10px",
											borderRadius: 8,
											border: "1px solid var(--dsw-alias-border-l1)",
											background: "var(--dsw-alias-surface-raised)",
											color: "var(--dsw-alias-label-primary)",
											font: "inherit",
											fontSize: 13
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											lineHeight: 1.6,
											color: "var(--dsw-alias-label-tertiary)",
											marginTop: 6
										},
										children: copy.settingsFunasrStartCommandHint
									})
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 13,
											fontWeight: 600,
											marginBottom: 8
										},
										children: copy.settingsFunasrStartCwd
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "text",
										value: prefs.funasrStartCwd,
										placeholder: copy.settingsFunasrStartCwdPlaceholder,
										onChange: (event) => applyPrefs({
											...prefs,
											funasrStartCwd: event.target.value
										}),
										spellCheck: false,
										autoComplete: "off",
										style: {
											width: "100%",
											padding: "8px 10px",
											borderRadius: 8,
											border: "1px solid var(--dsw-alias-border-l1)",
											background: "var(--dsw-alias-surface-raised)",
											color: "var(--dsw-alias-label-primary)",
											font: "inherit",
											fontSize: 13
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											lineHeight: 1.6,
											color: "var(--dsw-alias-label-tertiary)",
											marginTop: 6
										},
										children: copy.settingsFunasrStartCwdHint
									})
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 13,
											fontWeight: 600,
											marginBottom: 8
										},
										children: copy.settingsFunasrIdleMinutes
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										value: String(prefs.funasrIdleMinutes),
										onChange: (event) => applyPrefs({
											...prefs,
											funasrIdleMinutes: Number(event.target.value)
										}),
										style: {
											width: "100%",
											padding: "8px 10px",
											borderRadius: 8,
											border: "1px solid var(--dsw-alias-border-l1)",
											background: "var(--dsw-alias-surface-raised)",
											color: "var(--dsw-alias-label-primary)",
											font: "inherit",
											fontSize: 13
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "0",
												children: copy.settingsFunasrIdleNever
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "3",
												children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "3")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "5",
												children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "5")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "10",
												children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "10")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "30",
												children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "30")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "60",
												children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "60")
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											lineHeight: 1.6,
											color: "var(--dsw-alias-label-tertiary)",
											marginTop: 6
										},
										children: copy.settingsFunasrIdleMinutesHint
									})
								] })
							] }),
							prefs.engine === "zhipu" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 13,
										fontWeight: 600,
										marginBottom: 8
									},
									children: copy.settingsApiKey
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "password",
									value: zhipuKey,
									placeholder: copy.settingsApiKeyPlaceholder,
									onChange: (event) => applyZhipuKey(event.target.value),
									spellCheck: false,
									autoComplete: "off",
									style: {
										width: "100%",
										padding: "8px 10px",
										borderRadius: 8,
										border: "1px solid var(--dsw-alias-border-l1)",
										background: "var(--dsw-alias-surface-raised)",
										color: "var(--dsw-alias-label-primary)",
										font: "inherit",
										fontSize: 13
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 12,
										lineHeight: 1.6,
										color: "var(--dsw-alias-label-tertiary)",
										marginTop: 6
									},
									children: copy.settingsApiKeyHint
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									marginBottom: 8
								},
								children: copy.settingsInsertMode
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 6
								},
								children: [["append", copy.settingsInsertAppend], ["replace", copy.settingsInsertReplace]].map(([mode, label]) => {
									const active = prefs.insertMode === mode;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										onClick: () => applyPrefs({
											...prefs,
											insertMode: mode
										}),
										style: {
											...optionButtonBase$1,
											...active ? optionButtonSelected$1 : null
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { fontWeight: 500 },
											children: label
										}), active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 14 })]
									}, mode);
								})
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 10
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 8,
										cursor: "pointer",
										fontSize: 13
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: prefs.pttEnabled,
										onChange: (event) => applyPrefs({
											...prefs,
											pttEnabled: event.target.checked
										})
									}), copy.settingsPtt]
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									lineHeight: 1.6,
									color: "var(--dsw-alias-label-tertiary)"
								},
								children: copy.restartHint
							})
						]
					})
				})
			] });
		}
		//#endregion
		//#region src/client/SettingsSection.tsx
		/**
		* 「语音输入」应用设置分区（设置窗口左侧导航的 settings.section 席位）。
		*
		* 与 composer 按钮里的设置对话框共享同一份偏好（localStorage
		* dsh.speechInput.v1）和智谱 Key 持久化（host 路由 + localStorage 缓存），
		* 两处入口改任一处都同步生效。本页面只做静态表单，不含识别逻辑。
		*
		* 注册契约（0.1.2-rc.1，与 dsh-plugin-desktop 的桌面设置页同形）：
		* `settings.section` 是 list 槽，第二参为 React 组件，宿主负责渲染；
		* label 提供导航标题。注意 list 槽组件由宿主按条目渲染，不要传入
		* vanilla {render} 对象（宿主不识别，页面会空白）。
		*/
		/** 设置项按钮的基础样式（与 composer 设置对话框同款）。 */
		const optionButtonBase = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			minWidth: 0,
			padding: "7px 10px",
			borderRadius: 10,
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			font: "inherit",
			fontSize: 13,
			lineHeight: 1.3,
			textAlign: "left"
		};
		/** 设置项按钮选中态样式。 */
		const optionButtonSelected = {
			borderColor: "var(--dsw-alias-state-business-primary)",
			background: "var(--dsw-alias-state-business-tertiary)",
			color: "var(--dsw-alias-label-primary-bluish)"
		};
		const fieldTitleStyle = {
			fontSize: 13,
			fontWeight: 600,
			marginBottom: 8
		};
		const hintStyle = {
			fontSize: 12,
			lineHeight: 1.6,
			color: "var(--dsw-alias-label-tertiary)",
			marginTop: 6
		};
		/**
		* 语音输入设置分区页面。
		*
		* Key 输入即存（与对话框一致）；插入模式与长按空格开关点击即生效。
		*/
		function SpeechInputSettingsSection(_props) {
			const copy = UI_COPY;
			const [prefs, setPrefs] = (0, react.useState)(() => loadPreferences());
			const [zhipuKey, setZhipuKey] = (0, react.useState)(() => loadZhipuApiKeyCached());
			/** 挂载时从 host 拉取持久化的智谱 API Key（覆盖 localStorage 缓存）。 */
			(0, react.useEffect)(() => {
				let cancelled = false;
				loadZhipuApiKey().then((remoteKey) => {
					if (cancelled || remoteKey === "") return;
					setZhipuKey(remoteKey);
					saveZhipuApiKey(remoteKey);
				});
				return () => {
					cancelled = true;
				};
			}, []);
			const applyPrefs = (0, react.useCallback)((next) => {
				setPrefs(next);
				savePreferences(next);
			}, []);
			const applyZhipuKey = (0, react.useCallback)((key) => {
				setZhipuKey(key);
				saveZhipuApiKey(key);
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 16,
					maxWidth: 560,
					maxHeight: "min(60vh, 520px)",
					overflowY: "auto",
					paddingRight: 8,
					overscrollBehavior: "contain"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							fontSize: 15,
							fontWeight: 700,
							margin: 0,
							marginBottom: 6
						},
						children: copy.settingsTitle
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: hintStyle,
						children: copy.settingsDescription
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: fieldTitleStyle,
						children: copy.settingsEngine
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6
						},
						children: [[
							"funasr",
							copy.engineFunasr,
							copy.engineFunasrDesc
						], [
							"zhipu",
							copy.engineZhipu,
							copy.engineZhipuDesc
						]].map(([engine, label, desc]) => {
							const active = prefs.engine === engine;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => {
									const next = {
										...prefs,
										engine
									};
									applyPrefs(next);
									if (engine === "funasr" && next.funasrAutoStart) ensureFunasrStarted(next);
								},
								style: {
									...optionButtonBase,
									...active ? optionButtonSelected : null
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { fontWeight: 500 },
										children: label
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											marginLeft: "auto",
											fontSize: 12,
											color: "var(--dsw-alias-label-tertiary)"
										},
										children: desc
									}),
									active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 14 })
								]
							}, engine);
						})
					})] }),
					prefs.engine === "funasr" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: fieldTitleStyle,
								children: copy.settingsFunasrUrl
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								value: prefs.funasrUrl,
								placeholder: copy.settingsFunasrUrlPlaceholder,
								onChange: (event) => applyPrefs({
									...prefs,
									funasrUrl: event.target.value
								}),
								spellCheck: false,
								autoComplete: "off",
								style: {
									width: "100%",
									boxSizing: "border-box",
									padding: "8px 10px",
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l1)",
									background: "var(--dsw-alias-surface-raised)",
									color: "var(--dsw-alias-label-primary)",
									font: "inherit",
									fontSize: 13
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: hintStyle,
								children: copy.settingsFunasrUrlHint
							})
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: fieldTitleStyle,
								children: copy.settingsFunasrModel
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								value: prefs.funasrModel,
								placeholder: copy.settingsFunasrModelPlaceholder,
								onChange: (event) => applyPrefs({
									...prefs,
									funasrModel: event.target.value
								}),
								spellCheck: false,
								autoComplete: "off",
								style: {
									width: "100%",
									boxSizing: "border-box",
									padding: "8px 10px",
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l1)",
									background: "var(--dsw-alias-surface-raised)",
									color: "var(--dsw-alias-label-primary)",
									font: "inherit",
									fontSize: 13
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: hintStyle,
								children: copy.settingsFunasrModelHint
							})
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								cursor: "pointer",
								fontSize: 13
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: prefs.funasrAutoStart,
								onChange: (event) => applyPrefs({
									...prefs,
									funasrAutoStart: event.target.checked
								})
							}), copy.settingsFunasrAutoStart]
						}) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: fieldTitleStyle,
								children: copy.settingsFunasrStartCommand
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								value: prefs.funasrStartCommand,
								placeholder: copy.settingsFunasrStartCommandPlaceholder,
								onChange: (event) => applyPrefs({
									...prefs,
									funasrStartCommand: event.target.value
								}),
								spellCheck: false,
								autoComplete: "off",
								style: {
									width: "100%",
									boxSizing: "border-box",
									padding: "8px 10px",
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l1)",
									background: "var(--dsw-alias-surface-raised)",
									color: "var(--dsw-alias-label-primary)",
									font: "inherit",
									fontSize: 13
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: hintStyle,
								children: copy.settingsFunasrStartCommandHint
							})
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: fieldTitleStyle,
								children: copy.settingsFunasrStartCwd
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								value: prefs.funasrStartCwd,
								placeholder: copy.settingsFunasrStartCwdPlaceholder,
								onChange: (event) => applyPrefs({
									...prefs,
									funasrStartCwd: event.target.value
								}),
								spellCheck: false,
								autoComplete: "off",
								style: {
									width: "100%",
									boxSizing: "border-box",
									padding: "8px 10px",
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l1)",
									background: "var(--dsw-alias-surface-raised)",
									color: "var(--dsw-alias-label-primary)",
									font: "inherit",
									fontSize: 13
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: hintStyle,
								children: copy.settingsFunasrStartCwdHint
							})
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: fieldTitleStyle,
								children: copy.settingsFunasrIdleMinutes
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: String(prefs.funasrIdleMinutes),
								onChange: (event) => applyPrefs({
									...prefs,
									funasrIdleMinutes: Number(event.target.value)
								}),
								style: {
									width: "100%",
									boxSizing: "border-box",
									padding: "8px 10px",
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l1)",
									background: "var(--dsw-alias-surface-raised)",
									color: "var(--dsw-alias-label-primary)",
									font: "inherit",
									fontSize: 13
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "0",
										children: copy.settingsFunasrIdleNever
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "3",
										children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "3")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "5",
										children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "5")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "10",
										children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "10")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "30",
										children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "30")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "60",
										children: copy.settingsFunasrIdleMinutesOption.replace("{n}", "60")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: hintStyle,
								children: copy.settingsFunasrIdleMinutesHint
							})
						] })
					] }),
					prefs.engine === "zhipu" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: fieldTitleStyle,
							children: copy.settingsApiKey
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "password",
							value: zhipuKey,
							placeholder: copy.settingsApiKeyPlaceholder,
							onChange: (event) => applyZhipuKey(event.target.value),
							spellCheck: false,
							autoComplete: "off",
							style: {
								width: "100%",
								boxSizing: "border-box",
								padding: "8px 10px",
								borderRadius: 8,
								border: "1px solid var(--dsw-alias-border-l1)",
								background: "var(--dsw-alias-surface-raised)",
								color: "var(--dsw-alias-label-primary)",
								font: "inherit",
								fontSize: 13
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: hintStyle,
							children: copy.settingsApiKeyHint
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: fieldTitleStyle,
						children: copy.settingsInsertMode
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6
						},
						children: [["append", copy.settingsInsertAppend], ["replace", copy.settingsInsertReplace]].map(([mode, label]) => {
							const active = prefs.insertMode === mode;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => applyPrefs({
									...prefs,
									insertMode: mode
								}),
								style: {
									...optionButtonBase,
									...active ? optionButtonSelected : null
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { fontWeight: 500 },
									children: label
								}), active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 14 })]
							}, mode);
						})
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 10
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								cursor: "pointer",
								fontSize: 13
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: prefs.pttEnabled,
								onChange: (event) => applyPrefs({
									...prefs,
									pttEnabled: event.target.checked
								})
							}), copy.settingsPtt]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: hintStyle,
						children: copy.restartHint
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** 依赖的运行时服务：slots 注册面。 */
		const inject = ["slots"];
		/** 设置导航行标记（供 CSS 把 fallback 齿轮换成麦克风图标）。 */
		const NAV_MARKER = "data-dsh-speech-input-settings-nav";
		/**
		* 给设置导航里本插件的行打标记（同 dsh-better-sidebar 的做法：宿主 0.1.x
		* 从 settings.section 注册只投影 id/order/label，图标由 shell 按内置 id 硬编码，
		* 席位无图标字段，只能在对话框挂载后按 label 文本定位自己的行）。
		* @returns 清理函数（移除本插件拥有的标记）。
		*/
		function registerSettingsNavMarker() {
			const sync = () => {
				const buttons = document.querySelectorAll("[role=\"dialog\"] nav button");
				for (const button of buttons) if (button.textContent?.trim() === "语音输入") button.setAttribute(NAV_MARKER, "");
				else button.removeAttribute(NAV_MARKER);
			};
			sync();
			const observer = new MutationObserver(sync);
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				characterData: true
			});
			return () => {
				observer.disconnect();
				document.querySelectorAll(`[${NAV_MARKER}]`).forEach((el) => el.removeAttribute(NAV_MARKER));
			};
		}
		/** 导航图标替换样式：隐藏 fallback 齿轮，用麦克风 glyph（跟随 currentColor）。 */
		const NAV_ICON_CSS = `
[data-dsh-speech-input-settings-nav] > svg:first-child { display: none; }
[data-dsh-speech-input-settings-nav]::before {
  content: ''; flex: none; width: 16px; height: 16px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='9' y='2' width='6' height='12' rx='3'/%3E%3Cpath d='M5 10a7 7 0 0 0 14 0'/%3E%3Cpath d='M12 19v3'/%3E%3C/svg%3E") no-repeat center / contain;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='9' y='2' width='6' height='12' rx='3'/%3E%3Cpath d='M5 10a7 7 0 0 0 14 0'/%3E%3Cpath d='M12 19v3'/%3E%3C/svg%3E") no-repeat center / contain;
}
`;
		/**
		* 挂载语音输入按钮组。
		* @param ctx - 浏览器端根上下文。
		*/
		function apply(ctx) {
			const style = document.createElement("style");
			style.id = "dsh-speech-input-nav-icon";
			style.textContent = NAV_ICON_CSS;
			document.head.appendChild(style);
			registerSettingsNavMarker();
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "speech-input",
				order: 210
			}, SpeechInputButton));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "speech-input",
				order: 50,
				label: () => "语音输入"
			}, SpeechInputSettingsSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map