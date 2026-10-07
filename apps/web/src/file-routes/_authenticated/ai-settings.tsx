import { createFileRoute } from "@tanstack/react-router";
import { AiSettingsPage } from "../../routes/AiSettingsPage.tsx";

export const Route = createFileRoute("/_authenticated/ai-settings")({ component: AiSettingsPage });
