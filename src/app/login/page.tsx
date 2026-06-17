import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const session = await auth();
  if (session) redirect("/");

  return (
    <main className="login-screen">
      <section className="login-card">
        <p className="eyebrow">Tracker</p>
        <h1>Inloggen</h1>
        <p className="muted">Alle data is afgeschermd. Log in met een geautoriseerd account.</p>
        <LoginForm />
      </section>
    </main>
  );
}
