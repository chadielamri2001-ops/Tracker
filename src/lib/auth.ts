import { Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import NextAuth, { type NextAuthConfig } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";
import { assertRateLimit } from "./rate-limit";
import { prisma } from "./prisma";

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(256)
});

export const authConfig = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  secret: process.env.NEXTAUTH_SECRET,
  trustHost: true,
  pages: { signIn: "/login" },
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === "production" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production"
      }
    },
    csrfToken: {
      name: process.env.NODE_ENV === "production" ? "__Host-next-auth.csrf-token" : "next-auth.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production"
      }
    }
  },
  providers: [
    CredentialsProvider({
      name: "Email en wachtwoord",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Wachtwoord", type: "password" }
      },
      async authorize(credentials, request) {
        const parsed = credentialsSchema.safeParse(credentials);
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
        await assertRateLimit({ scope: "auth", identifier: ip, limit: 8, windowMs: 15 * 60 * 1000 });

        if (!parsed.success) return null;
        const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
        if (!user) return null;

        const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      }
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role: Role }).role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.id);
        session.user.role = token.role as Role;
      }
      return session;
    }
  }
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Niet ingelogd.");
  }
  return session.user;
}
