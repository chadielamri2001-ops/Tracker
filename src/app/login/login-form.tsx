"use client";

import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setError("");
        startTransition(async () => {
          const result = await signIn("credentials", {
            email: form.get("email"),
            password: form.get("password"),
            redirect: false,
            callbackUrl: searchParams.get("callbackUrl") || "/"
          });
          if (result?.error) {
            setError("E-mail of wachtwoord klopt niet.");
            return;
          }
          router.push(result?.url || "/");
          router.refresh();
        });
      }}
    >
      <label>
        E-mail
        <input
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </label>
      <label>
        Wachtwoord
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          minLength={8}
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary" disabled={pending} type="submit">
        {pending ? "Bezig..." : "Inloggen"}
      </button>
    </form>
  );
}
