"use client";

import { Typography } from "antd";

/**
 * antd's compound components (`Typography.Title`, ...) cannot be reached from a
 * Server Component: the import becomes a client reference and property access
 * on it yields `undefined`. Resolving the sub-components inside this Client
 * Component module gives Server Components a directly importable client
 * boundary, without deep-importing antd internals.
 */
export const Title = Typography.Title;
export const Paragraph = Typography.Paragraph;
export const Text = Typography.Text;
