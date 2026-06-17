import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getTrackerData } from "@/server/data";
import { TrackerApp } from "@/components/tracker-app";

export default async function HomePage() {
  const session = await auth();
  if (!session) redirect("/login");

  const data = await getTrackerData();
  return <TrackerApp data={data} userEmail={session.user.email || "gebruiker"} />;
}
