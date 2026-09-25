import { Plugin } from "@opencode/plugin"
import { setup } from "./lib/plugin.js"

export default Plugin.define({
    id: "opencode-context-compress",
    setup,
})
