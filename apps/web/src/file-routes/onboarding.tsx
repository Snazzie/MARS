import { createFileRoute } from "@tanstack/react-router";
import { OnboardingPage } from "../routes/OnboardingPage.tsx";

export const Route = createFileRoute("/onboarding")({ component: OnboardingPage });
