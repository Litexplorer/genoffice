import { describe, expect, it, vi } from 'vitest'

const registerSchemesAsPrivileged = vi.fn()

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: (...args: unknown[]) => registerSchemesAsPrivileged(...args),
  },
}))

import { registerPrivilegedSchemesOnce } from '../src/renderer-protocol'

describe('privileged scheme registration', () => {
  it('registers the first list and refuses a second call', () => {
    const schemes = [{ scheme: 'genoffice-app', privileges: { standard: true, secure: true } }]
    registerPrivilegedSchemesOnce(schemes)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith(schemes)

    // Electron 的第二次调用会替换第一次的清单，而不是合并：渲染进程会掉出安全上下文
    expect(() => registerPrivilegedSchemesOnce([])).toThrow(/called twice/)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
  })
})
