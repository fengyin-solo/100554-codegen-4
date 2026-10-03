// Node 冒烟测试前置：给纯前端的 localStorage 持久化层一个内存实现。
const memory = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (key) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key, value) => {
      memory.set(key, String(value))
    },
    removeItem: (key) => {
      memory.delete(key)
    },
    clear: () => memory.clear(),
  },
} as unknown as Window & typeof globalThis
