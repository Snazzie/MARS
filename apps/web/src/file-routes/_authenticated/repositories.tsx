import { createFileRoute } from "@tanstack/react-router";
import { RepositoriesPage } from "../../routes/RepositoriesPage.tsx";

export const Route = createFileRoute("/_authenticated/repositories")({
  component: RepositoriesPage,
  staticData: { navigation: { label: "Repositories", order: 3, section: "primary", help: { label: "About repository setup", text: "What: repositories available through the selected GitHub App installation. How: preview workflow label changes before opening a pull request. Fix: manage the installation when a repository is missing or access is stale." } } },
});
