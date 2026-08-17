import { invoke } from "@tauri-apps/api/core";

/**
 * 运行容器探测：同一份代码跑在浏览器（开发预览）或 Tauri webview（桌面 app）。
 *
 * 窗口形态：tauri.conf.json 里 `decorations: false` —— 无系统红绿灯的完全无边框，
 * 经典 Mac 风格的 close/shade/zoom 方框由前端自绘（TopBar.tsx），
 * 通过 @tauri-apps/api/window 调用，权限见 src-tauri/capabilities/default.json。
 * 浏览器预览时这些按钮静默无操作。
 */
export const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/**
 * 读一个文本文件给右侧预览框。
 *
 * dsh 没有读文件的 RPC（`host.*` 只能列目录和在 Finder 里打开），所以由壳自己读。
 * `roots` 是硬围栏不是提示：路径是从模型输出里捞出来的，只有 canonicalize 之后
 * 仍落在用户打开过的目录里才允许读。
 */
export function readPreviewFile(roots: string[], path: string): Promise<string> {
  if (!isTauri) return Promise.reject(new Error("文件预览只在桌面 app 里可用"));
  return invoke<string>("read_preview_file", { roots, path });
}

/**
 * 把一张图交给 `describe-image` 存下来，拿回要写进正文的引用。
 *
 * DeepSeek 不收图，`session.prompt` 里带 image block 会被整轮退掉。这条路把
 * 字节存在会话之外，正文里只留一行 `![图片](/describe-image/raw/sha256:…)`，
 * 模型看到后自己调 `describe_image` 去读，读回来的是文字。
 *
 * 上传本身是插件 browser 半边的活，而那半边注入的是被我们换掉的 dsh 自带界面，
 * 所以由壳自己发这个 POST——路由在同一个 webserver 上，不认前端。
 */
export function attachImage(
  mediaType: string,
  data: string,
  name?: string
): Promise<string> {
  if (!isTauri) return Promise.reject(new Error("发图只在桌面 app 里可用"));
  return invoke<string>("dsh_attach_image", { mediaType, data, name });
}

/**
 * 把存下来的图取回来给时间线显示。
 *
 * 走不了 `session.attachment`——那条要求图片是消息里的 image block，
 * 而我们发的是一行 note（实测回 `ATTACHMENT_NOT_REFERENCED`）。
 * 插件自己的 raw 路由认这个 id，但它查的是内存表，运行时一重启就 404，
 * 那时候时间线退回 note 自带的文件名和尺寸。
 */
export function loadPastedImage(attachmentId: string): Promise<string> {
  if (!isTauri) return Promise.reject(new Error("图片只在桌面 app 里可用"));
  return invoke<string>("dsh_image_preview", { attachmentId });
}

/** 外链交给系统默认浏览器（Tauri）或新标签页（浏览器预览兜底）。非 http(s) 一律拒绝。 */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri) {
    void invoke("open_external", { url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
