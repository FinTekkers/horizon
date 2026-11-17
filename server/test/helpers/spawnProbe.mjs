// HO-878: the positive control for a child_process spy. A module that, like
// server code, takes spawnSync as a named ESM import, so a spy installed with
// mock.method + syncBuiltinESMExports() must see this call.
import { spawnSync } from 'node:child_process'

export const spawnGitVersion = () => spawnSync('git', ['--version'], { stdio: 'ignore' })
