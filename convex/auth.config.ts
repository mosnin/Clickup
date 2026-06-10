// Convex reads this file to know how to validate Clerk JWTs.
// Set up a JWT template named "convex" in the Clerk dashboard
// (Clerk -> JWT Templates -> New template -> Convex preset),
// then put the Frontend API URL in NEXT_PUBLIC_CLERK_FRONTEND_API_URL.
export default {
  providers: [
    {
      domain: process.env.NEXT_PUBLIC_CLERK_FRONTEND_API_URL,
      applicationID: "convex",
    },
  ],
};
