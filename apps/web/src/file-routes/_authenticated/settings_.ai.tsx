import { createFileRoute } from "@tanstack/react-router";
import { AiSettingsPage } from "../../routes/AiSettingsPage.tsx";

export const Route = createFileRoute("/_authenticated/settings_/ai")({
  component: AiSettingsPage,
  staticData: { navigation: { label: "AI", order: 2, section: "settings", adminOnly: true, help: { label: "About AI settings", text: "Connect a local or cloud model provider, then opt repositories into failure analysis. Failed log excerpts are sent to the selected endpoint and advisory feedback is posted by the installed MARS App. Only global administrators can change this configuration." } } },
});
