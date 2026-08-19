/**
 * 类型引用：触发 @deepseek-ai/cordis-plugin-timer 的 Context 模块声明合并
 * （ctx.timeout / ctx.interval / ctx.timer）。运行时由宿主 dsh-base bundle 提供，
 * 本包 devDeps 仅为类型检查；编译产物不 import 它。
 */
import type {} from '@deepseek-ai/cordis-plugin-timer'
/**
 * 类型引用：触发 @deepseek-ai/dsh-host-webserver / dsh-tools / dsh-shell 的
 * Context 模块声明合并（ctx.webServer / ctx.tools / ctx.shell）。
 * 运行时由宿主提供（peerDeps），本包 devDeps 仅为类型检查。
 */
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
