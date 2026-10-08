import { version } from "../package.json";

declare const __APP_VERSION__: string;

export const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : version;
export const GITHUB_URL = "https://github.com/KrunkZhou/FIT-Viewer";
