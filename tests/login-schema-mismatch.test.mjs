// 端到端：login_fails 缺 blocks 时，登录必须 503（fail-closed）
//
// 单独一个文件是必要的：ensureLoginSchema 的就绪状态按模块缓存，
// 同进程里跑过一个"结构正常"的用例，这里就测不到缺列分支了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, postLogin } from './helpers/d1.mjs'

test('缺 blocks 列：登录返回 503 而不是无限流地校验口令', async () => {
  const worker = (await import('../src/worker.js')).default
  const env = makeEnv({ loginFails: 'legacy' })

  const r = await postLogin(worker, env, { username: 'nobody-here', password: 'wrong-password-1', ip: '198.51.100.24' })

  assert.equal(r.status, 503, '结构不一致时必须拒绝，不能降级为"照常校验口令"')
  assert.match(r.body.error, /暂时不可用/, '应给出可解释的文案，而不是裸 key 或 500')
  // 关键：此时不应产生任何口令校验结果（401/403），也不能写入计数
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails').all()
  assert.equal(Number(rows.results[0].n), 0, '缺列时不应写入任何计数行')
})
