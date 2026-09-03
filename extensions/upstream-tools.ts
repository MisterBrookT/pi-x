import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerLsp from "../node_modules/@narumitw/pi-lsp/dist/index.ts";
import registerSubagents from "pi-subagents";
import registerWebAccess from "pi-web-access";

function toolsOnly(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerCommand") return () => {};
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function (pi: ExtensionAPI) {
  const api = toolsOnly(pi);
  registerSubagents(api);
  registerWebAccess(api);
  registerLsp(api);
}
