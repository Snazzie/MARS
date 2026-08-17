import { createFileRoute } from "@tanstack/react-router";
import { RepositoriesPage } from "../../routes/RepositoriesPage.tsx";

export const Route = createFileRoute("/_authenticated/repositories")({ component: RepositoriesPage });
