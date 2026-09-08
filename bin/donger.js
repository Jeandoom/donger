#!/usr/bin/env node
// 全局 donger 命令入口：经 tsx 加载 CLI TS 源码（npm link 后指向本文件，realpath 回仓库根，可解析根 node_modules 的 tsx）
import { tsImport } from "tsx/esm/api";

await tsImport("../cli/src/index.ts", import.meta.url);
