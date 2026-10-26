import { backupDatabase } from "../src/dbBackup.js";

(async () => {
  try {
    const backupFile = await backupDatabase();
    console.log(`Database backup completed: ${backupFile}`);
    process.exit(0);
  } catch (error) {
    console.error("Database backup failed:", error);
    process.exit(1);
  }
})();
