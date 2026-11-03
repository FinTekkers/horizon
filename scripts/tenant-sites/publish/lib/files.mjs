import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { PublishError } from './errors.mjs'

// git's blob id for these bytes: sha1("blob <len>\0" + bytes). It matches the
// sha GitHub returns, so unchanged files and an unchanged tree are skipped.
export function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

// Every file under dir, sorted by path, with '/' separators. Nothing is
// skipped (dotfiles, package.json and check-links.mjs included): the folder is
// published as-is. The executable bit is kept (100755); everything else is
// 100644. A symlink or other special file is refused rather than guessed at.
export async function listSiteFiles(dir) {
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new PublishError(`site folder not found: ${dir}`)
  }
  const out = []
  async function walk(rel) {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true })
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(relPath)
      } else if (e.isFile()) {
        const abs = path.join(dir, relPath)
        const content = await readFile(abs)
        const mode = (await stat(abs)).mode & 0o111 ? '100755' : '100644'
        out.push({ path: relPath, mode, size: content.length, blobSha: blobSha(content), content })
      } else {
        throw new PublishError(`${relPath} is a symlink or special file: replace it with a regular file before publishing`)
      }
    }
  }
  await walk('')
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
