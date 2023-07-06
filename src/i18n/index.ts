import en from "./en.js";
import { env } from "vscode";
import zhCn from "./zh-cn.js";

type AvailableLanguages = "en" | "zh-cn";

const availableLanguages: readonly Exclude<AvailableLanguages, "en">[] = ["zh-cn"];

const lang = availableLanguages.find((value) => env.language === value);

const i18n = (() => {
  switch (lang) {
    case "zh-cn":
      return zhCn;
    default:
      return en;
  }
})();

export default i18n;
