import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../../routes/SettingsPage.tsx";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  staticData: { navigation: { label: "General", order: 1, section: "settings", help: { label: "About deployment settings", text: "What: appearance, signed-in access, GitHub connections, and API quota. How: select a workspace before managing its GitHub installation. Fix: retry failed connection checks or manage repository access in GitHub." } } },
});
