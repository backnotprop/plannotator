#!/usr/bin/env node
import { renderFile } from "./render.js";

const [command, ...args] = process.argv.slice(2);
const usage = "Usage: plannotator-diagrams render <input.diagram.json> -o <output.svg>";
if (command === "--help" || command === "-h" || (command === "render" && ["--help", "-h"].includes(args[0]))) {
  console.log(usage);
} else {
  try {
    if (command !== "render") throw new Error(usage);
    const problems = await renderFile(args);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exitCode = 1;
  }
}
