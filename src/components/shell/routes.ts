/**
 * The rail's routes, kept apart from `./definitions` so Server Components can
 * import them: the definitions module pulls in `@ant-design/icons`, which is
 * client-only and cannot be evaluated during server rendering.
 */
export const TAB_ROUTES = {
  /** Overview lives at the root, as in the consumer app: it is the landing page. */
  overview: "/",
  constants: "/constants",
  userManagement: "/user-management",
  support: "/support",
} as const;
