import { AppLogger } from "@main/services/logger";
import { CompanionPaths } from "@main/storage/paths";

export const companionPaths = new CompanionPaths();
export const appLogger = new AppLogger(companionPaths);
