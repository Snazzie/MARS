import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../../routes/SettingsPage.tsx";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });
