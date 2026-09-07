/**
 * Server startup hook (`register` runs once per server instance, before the
 * first request is served).
 *
 * The only thing it does today is start the integration scheduler
 * (`src/lib/integrations/scheduler.ts`), which ticks every 60 seconds and
 * starts the integrations whose time has come.
 *
 * Two rules this file exists to honour:
 *
 * - **Nothing heavy at module scope.** Next evaluates `instrumentation.ts` for
 *   the Edge runtime as well as Node, and importing Prisma (or anything that
 *   imports `server-only` plus a driver) at the top level would break that
 *   build. The scheduler is therefore a dynamic `import()` inside the guard.
 * - **Opt out, per process.** `INTEGRATIONS_SCHEDULER=off` leaves the app
 *   fully functional and simply starts nothing on its own, which is what a
 *   developer running a second copy — or a deployment that runs the schedule
 *   elsewhere — wants. The Integrations page reports which it is
 *   (`schedulerActive`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.INTEGRATIONS_SCHEDULER === "off") return;
  const { startScheduler } = await import("@/lib/integrations/scheduler");
  startScheduler();
}
