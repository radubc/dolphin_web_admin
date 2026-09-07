/**
 * Routes the shell links to from Server Components. The rail itself is driven
 * by the access map; this only names the paths code has to redirect to.
 */
export const TAB_ROUTES = {
  overview: "/",
  constants: "/constants",
  userManagement: "/user-management",
  support: "/support",
  accessMap: "/access-map",
  services: "/services",
  integrations: "/integrations",
} as const;
