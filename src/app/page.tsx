import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getTrackerData } from "@/server/data";
import { getAnalytics } from "@/server/analytics";
import { TrackerApp } from "@/components/tracker-app";

export default async function HomePage() {
  const session = await auth();
  if (!session) redirect("/login");

  const [data, analytics] = await Promise.all([getTrackerData(), getAnalytics()]);
  return <TrackerApp data={data} analytics={analytics} userEmail={session.user.email || "gebruiker"} />;
}
