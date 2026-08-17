/**
 * 花了多少钱。
 *
 * dsh 自己不带价目表——`dsh-llm-deepseek` 的 model 定义里只有 id / name /
 * contextWindow，`dsh-token-meter` 只数 token。所以这张表是壳自己维护的，
 * 抄自 DeepSeek 官方文档（api-docs.deepseek.com/zh-cn/quick_start/pricing），
 * **2026-08-16 核对**。官方调价这里就得跟着改，没有别的地方会提醒你。
 *
 * 口径（`dsh-llm-deepseek` 的 `mapUsage` 已核对）：
 * - 官方的 `prompt_tokens` 含缓存命中，harness 约定是**互不重叠**的三份，
 *   所以 `inputTokens` 正好等于 `prompt_cache_miss_tokens`，直接按未命中价算。
 * - DeepSeek 线路**从不上报 `cacheWriteTokens`**（官方没有这项收费）。这里仍按
 *   未命中价计，是给别的 provider 留的兜底，官方线路上它恒为 0。
 */

/** 元 / 百万 token */
interface ModelPrice {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/**
 * 高峰时段（北京时间）。
 *
 * 「高峰时段」「空闲时段」是官方原词（api-docs.deepseek.com/zh-cn/quick_start/pricing，
 * 2026-08-17 复核），不是这里造的说法，改文案前先去看官方页面。
 * 官方按北京时间划档，和机器时区无关，所以下面一律用 UTC+8 算。
 */
export const PEAK_WINDOWS: readonly (readonly [number, number])[] = [
  [9, 12],
  [14, 18],
];

export type Band = "peak" | "offPeak";

export const BAND_LABEL: Record<Band, string> = { peak: "高峰时段", offPeak: "空闲时段" };

/** 表头、换档提示这些挤不下全称的地方用它 */
export const BAND_SHORT: Record<Band, string> = { peak: "高峰", offPeak: "空闲" };

/** 另一个档。换档提示要说的是"转到哪一档"。 */
export function otherBand(band: Band): Band {
  return band === "peak" ? "offPeak" : "peak";
}

/** 北京时间当天已过的分钟数。从 UTC 推，用户把机器时区调到哪里都不影响档位。 */
function beijingMinutes(at: Date): number {
  return (at.getUTCHours() * 60 + at.getUTCMinutes() + 8 * 60) % (24 * 60);
}

/** 北京时间的钟点落在哪个档 */
export function bandAtHour(hour: number): Band {
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to) ? "peak" : "offPeak";
}

export function bandAt(at: Date): Band {
  return bandAtHour(Math.floor(beijingMinutes(at) / 60));
}

/** 现在这一刻的北京时间钟点，画时段条时用来标"现在在哪儿" */
export function beijingHour(at: Date): number {
  return Math.floor(beijingMinutes(at) / 60);
}

/** 下一次换档：换到几点（北京时间的整点）、还有多少分钟 */
export function nextBandChange(at: Date): { band: Band; hour: number; inMinutes: number } {
  const minutes = beijingMinutes(at);
  const edges = PEAK_WINDOWS.flatMap(([from, to]) => [from, to]).sort((a, b) => a - b);
  /* 过了当天最后一个边界就绕回明天的第一个 */
  const next = edges.find((hour) => hour * 60 > minutes) ?? edges[0] + 24;
  return { band: bandAt(at), hour: next % 24, inMinutes: next * 60 - minutes };
}

/** 高峰价。空闲时段官方五折，见 `OFF_PEAK_RATE`。 */
const PEAK_PRICES: Record<string, ModelPrice> = {
  "deepseek-v4-flash": { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
  "deepseek-v4-pro": { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
};

/** 认不出的 Model 按贵的那档算：宁可高估，也不要让人以为比实际便宜。 */
const FALLBACK = PEAK_PRICES["deepseek-v4-pro"];

/** 空闲时段是高峰价的五折 */
export const OFF_PEAK_RATE = 0.5;

/** 会话/某一天的 token 分档，字段名和 `ContextUsage`、`UsageDay` 对齐 */
export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 高峰价和空闲价两个端点。实际花费落在中间，取决于用的时候是哪个时段。 */
export interface CostRange {
  peak: number;
  offPeak: number;
}

/** `currentModel` 是 `<provider>/<model>` 路由键，价目表按裸 model id 查 */
export function modelIdOf(route: string): string {
  const cut = route.lastIndexOf("/");
  return cut === -1 ? route : route.slice(cut + 1);
}

/** 这一堆 token 按指定档位算多少钱 */
export function costOf(usage: CostInput, route: string, band: Band): number {
  const price = PEAK_PRICES[modelIdOf(route)] ?? FALLBACK;
  const peak =
    ((usage.inputTokens + usage.cacheWriteTokens) * price.cacheMiss +
      usage.cacheReadTokens * price.cacheHit +
      usage.outputTokens * price.output) /
    1_000_000;
  return band === "peak" ? peak : peak * OFF_PEAK_RATE;
}

export function estimateCost(usage: CostInput, route: string): CostRange {
  return { peak: costOf(usage, route, "peak"), offPeak: costOf(usage, route, "offPeak") };
}

/**
 * 金额。小数位跟着量级走：几分钱的会话写成 ¥0.00 等于什么也没说。
 */
export function formatCNY(value: number): string {
  if (value >= 100) return `¥${value.toFixed(0)}`;
  if (value >= 1) return `¥${value.toFixed(2)}`;
  return `¥${value.toFixed(3)}`;
}
