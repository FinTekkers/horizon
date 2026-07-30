// Minimal host shim for shoreward's Vercel-style api/contact.js handler.
// Runs as shoreward-contact.service on 127.0.0.1:3002; nginx proxies
// POST /api/contact here. Requires GMAIL_USER / GMAIL_APP_PASSWORD env.
import http from 'node:http'
import handler from '/opt/shoreward/api/contact.js'

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        req.body = JSON.parse(body || '{}')
      } catch {
        req.body = {}
      }
      const shim = {
        status(code) {
          res.statusCode = code
          return shim
        },
        json(obj) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(obj))
        },
      }
      try {
        await handler(req, shim)
      } catch (err) {
        console.error('contact handler failed:', err.message)
        res.statusCode = 500
        res.end('{"error":"send_failed"}')
      }
    })
  })
  .listen(3002, '127.0.0.1', () => console.log('shoreward-contact on 127.0.0.1:3002'))
