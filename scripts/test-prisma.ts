import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import prisma from "../src/prisma.js";
console.log("Client path:", require.resolve('@prisma/client'));
console.log("Prisma keys:", Object.keys(prisma).filter(k => !k.startsWith("_")));
process.exit(0);
