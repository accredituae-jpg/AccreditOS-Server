import prisma from "../prisma.js";
import { StatusService } from "../services/status.service.js";
import logger from "../logger.js";

/**
   * Scans for past upcoming trainings and flags them as pending
   */
export async function runTrainingStatusCheck() {
  logger.info("Running training status auto-completion check...");

  try {
    const now = new Date();

    // Find all upcoming trainings where regDate is in the past
    const pastTrainings = await prisma.training.findMany({
      where: {
        status: "upcoming",
        regDate: { lt: now },
      },
    });

    logger.info(`Found ${pastTrainings.length} past upcoming trainings to flag as pending.`);

    for (const training of pastTrainings) {
      try {
        await StatusService.changeTrainingStatus(
          training.id,
          "pending",
          "System",
          "Scheduled time has passed without marking completed."
        );
        logger.info({ trainingId: training.id }, "Flagged training as pending successfully.");
      } catch (err: any) {
        logger.error({ err, trainingId: training.id }, "Failed to flag training as pending.");
      }
    }

    logger.info("Training status check complete.");
  } catch (error) {
    logger.error({ err: error }, "Failed to run training status check.");
  }
}

/**
 * Initializes the training status background job
 */
export function startTrainingStatusJob() {
  // Run once immediately on startup
  runTrainingStatusCheck().catch((err) => logger.error({ err }, "Initial training check failed."));

  // Schedule to run every 15 minutes
  setInterval(() => {
    runTrainingStatusCheck().catch((err) => logger.error({ err }, "Periodic training check failed."));
  }, 15 * 60 * 1000);
}
