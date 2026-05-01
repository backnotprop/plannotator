import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Params = Record<string, string | number>;
type Translate = (key: string, fallback: string, params?: Params) => string;

let translate: Translate = (_key, fallback, params) => format(fallback, params);

function format(text: string, params?: Params): string {
	if (!params) return text;
	return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? `{${key}}`));
}

export function t(key: string, fallback: string, params?: Params): string {
	return translate(key, fallback, params);
}

const bundles = [
	{
		locale: "ja",
		namespace: "plannotator",
		messages: {
			"flag.plan.description": "計画モードで開始（制限付きの調査と計画作成）",
			"cmd.toggle.description": "plannotator の計画モードを切り替え",
			"cmd.status.description": "plannotator の状態を表示",
			"cmd.review.description": "現在の変更または PR URL のインタラクティブなコードレビューを開く",
			"cmd.annotate.description": "Markdown ファイルまたはフォルダーを注釈 UI で開く",
			"cmd.annotateMessage.description": "最後のアシスタントメッセージに注釈を付ける",
			"cmd.archive.description": "保存済みの計画判断を閲覧",
			"cmd.shortcut.description": "plannotator を切り替え",
			"notify.planning.enabled": "Plannotator: 計画モードを有効にしました。Markdown の計画を書いてレビューに提出してください。",
			"notify.disabled": "Plannotator: 無効にしました。全アクセスを復元しました。",
			"notify.review.assetsMissing": "Plannotator: コードレビュー UI アセットが見つかりません。拡張機能を再ビルドしてブラウザー UI を復元してください。",
			"notify.review.closed": "コードレビューセッションを閉じました。",
			"notify.review.noFeedback": "コードレビューを閉じました（フィードバックなし）。",
			"notify.review.failedStart": "コードレビュー UI の開始に失敗しました: {message}",
			"notify.annotate.usage": "使用方法: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--json]",
			"notify.annotate.fetching": "取得中: {path}{mode}...",
			"notify.annotate.failedFetch": "URL の取得に失敗しました: {message}",
			"notify.annotate.fileNotFound": "ファイルが見つかりません: {path}",
			"notify.annotate.cannotAccess": "アクセスできません: {path}",
			"notify.annotate.noMarkdown": "{path} に Markdown または HTML ファイルが見つかりません",
			"notify.annotate.openFolder": "フォルダー {path} の注釈 UI を開いています...",
			"notify.annotate.tooLarge": "ファイルが大きすぎます（{mb}MB、最大 10MB）",
			"notify.annotate.openFile": "{path} の注釈 UI を開いています...",
			"notify.annotate.approved": "注釈が承認されました。",
			"notify.annotate.closed": "注釈セッションを閉じました。",
			"notify.annotate.noFeedback": "注釈を閉じました（フィードバックなし）。",
			"notify.annotate.failedStart": "注釈 UI の開始に失敗しました: {message}",
			"notify.message.noAssistant": "セッションにアシスタントメッセージが見つかりません。",
			"notify.message.open": "最後のメッセージの注釈 UI を開いています...",
			"notify.message.approved": "メッセージが承認されました。",
			"notify.archive.open": "計画アーカイブを開いています...",
			"notify.archive.closed": "アーカイブブラウザーを閉じました。",
			"notify.archive.failedStart": "アーカイブの開始に失敗しました: {message}",
		},
	},
	{
		locale: "zh-CN",
		namespace: "plannotator",
		messages: {
			"flag.plan.description": "以计划模式启动（受限探索和计划）",
			"cmd.toggle.description": "切换 plannotator 计划模式",
			"cmd.status.description": "显示 plannotator 状态",
			"cmd.review.description": "为当前更改或 PR URL 打开交互式代码审查",
			"cmd.annotate.description": "在批注 UI 中打开 Markdown 文件或文件夹",
			"cmd.annotateMessage.description": "批注最后一条 assistant 消息",
			"cmd.archive.description": "浏览已保存的计划决策",
			"cmd.shortcut.description": "切换 plannotator",
			"notify.planning.enabled": "Plannotator: 已启用计划模式。请编写 Markdown 计划，然后提交审查。",
			"notify.disabled": "Plannotator: 已禁用。已恢复完整访问。",
			"notify.review.assetsMissing": "Plannotator: 缺少代码审查 UI 资源。请重新构建扩展以恢复浏览器 UI。",
			"notify.review.closed": "代码审查会话已关闭。",
			"notify.review.noFeedback": "代码审查已关闭（无反馈）。",
			"notify.review.failedStart": "启动代码审查 UI 失败: {message}",
			"notify.annotate.usage": "用法: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--json]",
			"notify.annotate.fetching": "正在获取: {path}{mode}...",
			"notify.annotate.failedFetch": "获取 URL 失败: {message}",
			"notify.annotate.fileNotFound": "文件未找到: {path}",
			"notify.annotate.cannotAccess": "无法访问: {path}",
			"notify.annotate.noMarkdown": "在 {path} 中未找到 Markdown 或 HTML 文件",
			"notify.annotate.openFolder": "正在为文件夹 {path} 打开批注 UI...",
			"notify.annotate.tooLarge": "文件过大（{mb}MB，最大 10MB）",
			"notify.annotate.openFile": "正在为 {path} 打开批注 UI...",
			"notify.annotate.approved": "批注已批准。",
			"notify.annotate.closed": "批注会话已关闭。",
			"notify.annotate.noFeedback": "批注已关闭（无反馈）。",
			"notify.annotate.failedStart": "启动批注 UI 失败: {message}",
			"notify.message.noAssistant": "会话中未找到 assistant 消息。",
			"notify.message.open": "正在为最后一条消息打开批注 UI...",
			"notify.message.approved": "消息已批准。",
			"notify.archive.open": "正在打开计划归档...",
			"notify.archive.closed": "归档浏览器已关闭。",
			"notify.archive.failedStart": "启动归档失败: {message}",
		},
	},
	{
		locale: "es",
		namespace: "plannotator",
		messages: {
			"flag.plan.description": "Iniciar en modo plan (exploración y planificación restringidas)",
			"cmd.toggle.description": "Alternar modo de planificación de plannotator",
			"cmd.status.description": "Mostrar estado de plannotator",
			"cmd.review.description": "Abrir revisión de código interactiva para cambios actuales o una URL de PR",
			"cmd.annotate.description": "Abrir archivo o carpeta Markdown en la UI de anotación",
			"cmd.annotateMessage.description": "Anotar el último mensaje del asistente",
			"cmd.archive.description": "Explorar decisiones de planes guardadas",
			"cmd.shortcut.description": "Alternar plannotator",
			"notify.planning.enabled": "Plannotator: modo de planificación activado. Escribe un plan Markdown y envíalo a revisión.",
			"notify.disabled": "Plannotator: desactivado. Acceso completo restaurado.",
			"notify.review.assetsMissing": "Plannotator: faltan recursos de la UI de revisión de código. Reconstruye la extensión para restaurar la UI del navegador.",
			"notify.review.closed": "Sesión de revisión de código cerrada.",
			"notify.review.noFeedback": "Revisión de código cerrada (sin feedback).",
			"notify.review.failedStart": "No se pudo iniciar la UI de revisión de código: {message}",
			"notify.annotate.usage": "Uso: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--json]",
			"notify.annotate.fetching": "Obteniendo: {path}{mode}...",
			"notify.annotate.failedFetch": "No se pudo obtener la URL: {message}",
			"notify.annotate.fileNotFound": "Archivo no encontrado: {path}",
			"notify.annotate.cannotAccess": "No se puede acceder: {path}",
			"notify.annotate.noMarkdown": "No se encontraron archivos Markdown o HTML en {path}",
			"notify.annotate.openFolder": "Abriendo UI de anotación para la carpeta {path}...",
			"notify.annotate.tooLarge": "Archivo demasiado grande ({mb}MB, máximo 10MB)",
			"notify.annotate.openFile": "Abriendo UI de anotación para {path}...",
			"notify.annotate.approved": "Anotación aprobada.",
			"notify.annotate.closed": "Sesión de anotación cerrada.",
			"notify.annotate.noFeedback": "Anotación cerrada (sin feedback).",
			"notify.annotate.failedStart": "No se pudo iniciar la UI de anotación: {message}",
			"notify.message.noAssistant": "No se encontró ningún mensaje del asistente en la sesión.",
			"notify.message.open": "Abriendo UI de anotación para el último mensaje...",
			"notify.message.approved": "Mensaje aprobado.",
			"notify.archive.open": "Abriendo archivo de planes...",
			"notify.archive.closed": "Navegador de archivo cerrado.",
			"notify.archive.failedStart": "No se pudo iniciar el archivo: {message}",
		},
	},
];

export function initI18n(pi: ExtensionAPI): void {
	const events = pi.events;
	if (!events) return;
	for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
	events.emit("pi-core/i18n/requestApi", {
		namespace: "plannotator",
		callback(api: { t?: Translate } | undefined) {
			if (typeof api?.t === "function") translate = api.t;
		},
	});
}
