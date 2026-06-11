import { redirect } from "next/navigation";
import type { Route } from "next";

export default function Home() {
  redirect("/markets" as Route);
}
