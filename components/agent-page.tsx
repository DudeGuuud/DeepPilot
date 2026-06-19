import { Bot, RadioTower, ShieldCheck } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const plannedCapabilities = [
  {
    title: "Strategy monitoring",
    description: "Watch active Predict positions and surface review checkpoints before market conditions drift.",
    icon: RadioTower
  },
  {
    title: "Risk review",
    description: "Apply DeepPilot guardrails to proposed actions before anything reaches a signing flow.",
    icon: ShieldCheck
  },
  {
    title: "Telegram-ready agent",
    description: "Route alerts and strategy prompts through the existing Telegram profile experience.",
    icon: Bot
  }
] as const;

export function AgentPage() {
  return (
    <AppShell
      title="DeepPilot Agent"
      description="A planned autonomous review, monitoring, and execution assistant for DeepBook Predict workflows."
      meta={<Badge variant="outline">Coming Soon</Badge>}
    >
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
        <Card className="glass-line">
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit border-border bg-background/45 text-muted-foreground">
              Product preview
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-3xl leading-tight sm:text-4xl">Coming Soon</CardTitle>
              <CardDescription className="max-w-2xl text-base leading-7">
                DeepPilot Agent will bring continuous strategy monitoring, risk review, and trader coordination into one
                workspace.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-border bg-background/45 p-4 text-sm leading-6 text-muted-foreground">
              Built for Predict traders who want a clearer view of active strategies, market drift, and next actions.
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3">
          {plannedCapabilities.map((item) => {
            const Icon = item.icon;

            return (
              <Card key={item.title}>
                <CardHeader className="flex-row items-start gap-3 space-y-0">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle>{item.title}</CardTitle>
                    <CardDescription className="mt-2 leading-6">{item.description}</CardDescription>
                  </div>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}
