/**
 * Catch-all 路由入口。
 *
 * 为什么存在：vercel.json 的 rewrites 在当前路由引擎下对多段路径不可靠
 * （实测所有非根路径都落到平台 NOT_FOUND）。文件系统的 catch-all 路由
 * （api/[...path].js）由 Vercel 核心保证匹配任意深度路径，零配置。
 *
 * 真正的逻辑全部在 api/proxy.js，这里只做转发。
 */
import { handler } from './proxy.js';

export default handler;
