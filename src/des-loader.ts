// des.js 是 CAS 平台原版 Guapo DES,内含隐式全局循环变量(非严格模式),
// ESM 严格模式会 ReferenceError,故用 node:vm 沙箱加载。
import vm from "node:vm"

const sandbox: { strEnc?: (data: string, k1: string, k2: string, k3: string) => string } = {}
vm.createContext(sandbox)
vm.runInContext(await Bun.file(new URL("./des.js", import.meta.url)).text(), sandbox)

export const strEnc = sandbox.strEnc!
