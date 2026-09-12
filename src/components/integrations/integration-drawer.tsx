"use client";

/**
 * Edit one integration: its address, whether it is enabled, when it runs, and
 * the handful of provider-specific knobs.
 *
 * An integration is never created or removed here — every one of them is
 * seeded by SQL — so this is only ever an edit, and only of the four things
 * the model says are editable. It follows the Constants form's conventions: `FormSection` blocks,
 * Save in the footer submitting by form association, the failure shown in the
 * form rather than a toast, and only the *changed* fields sent, so two
 * operators editing different parts of the same integration do not overwrite
 * each other.
 *
 * The drawer calls the API itself. `integrationsApi` announces every write on
 * `window`, and the store listens, so there is no callback to thread back for
 * the reload; the page is only told what to say in its toast.
 */

import { useState } from "react";
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  TimePicker,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { ApiOutlined, ClockCircleOutlined, SettingOutlined } from "@ant-design/icons";
import FormSection from "@/components/form-section";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { integrationsApi } from "@/lib/integrations/client";
import type {
  CatalogTarget,
  Integration,
  IntegrationPatch,
  IntegrationSchedule,
  IntegrationSettings,
  ScheduleFrequency,
} from "@/lib/integrations/types";
import {
  ALPHA_VANTAGE_REQUESTS_PER_MINUTE_DEFAULT,
  ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX,
  ALPHA_VANTAGE_REQUESTS_PER_RUN_DEFAULT,
  ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX,
  CATALOG_TARGETS,
  QUOTE_BATCH_SIZE_DEFAULT,
  QUOTE_BATCH_SIZE_MAX,
  QUOTE_CREDITS_PER_MINUTE_DEFAULT,
  SCHEDULE_FREQUENCIES,
} from "@/lib/integrations/types";
import { PROVIDER_BASE_URL_DOMAINS } from "@/lib/integrations/schemas";
import {
  ALLOCATION_MONTHS_DEFAULT,
  ALLOCATION_MONTHS_MAX,
  COST_COMPONENT_TAG_DEFAULT,
  COST_DAYS_DEFAULT,
  COST_FETCH_DAYS_MAX,
  FIXED_FLOOR_SHARE_DEFAULT,
  FIXED_FLOOR_SHARE_MAX,
} from "@/lib/costs/types";
import { POOL_METRICS_DAYS_DEFAULT, POOL_METRICS_DAYS_MAX } from "@/lib/customers/types";
import { errorMessage } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import {
  INTEGRATION_NOTES,
  INTEGRATIONS_COLOR,
  providerLabel,
  TIMEZONE_OPTIONS,
  WEEKDAY_NAMES,
} from "./integrations-meta";

/** Save lives in the footer, outside the form, and submits by association. */
const FORM_NAME = "integration-form";

const FREQUENCY_LABELS: Readonly<Record<ScheduleFrequency, string>> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  off: "Off — manual only",
};

const CATALOG_LABELS: Readonly<Record<CatalogTarget, string>> = {
  stocks: "Stocks",
  etfs: "ETFs",
  cryptocurrencies: "Cryptocurrencies",
};

/** Every field any integration can have; only the mounted ones are ever filled in. */
interface IntegrationFormValues {
  baseUrl: string;
  isEnabled: boolean;
  frequency: ScheduleFrequency;
  /** Wall-clock in `timezone`; only the hour and minute are read. */
  time: Dayjs;
  weekday: number;
  dayOfMonth: number;
  timezone: string;
  catalogs: CatalogTarget[];
  batchSize: number;
  creditsPerMinute: number;
  includeExpired: boolean;
  maxRequestsPerRun: number;
  requestsPerMinute: number;
  /** `aws_costs`: days the daily Cost Explorer fetch reaches back over. */
  days: number;
  /** `aws_costs`: the cost allocation tag the month's split is grouped by. */
  componentTag: string;
  /** `aws_costs`: which budget to read; empty means the first AWS returns. */
  budgetName: string;
  /** `cognito_directory`: days of CloudWatch counters each run re-fetches. */
  metricsDays: number;
  /** `allocate_costs`: months each run recomputes, ending with this one. */
  months: number;
  /** `allocate_costs`: the fixed pool's per-tenant floor, as a fraction. */
  fixedFloorShare: number;
}

export interface IntegrationDrawerProps {
  /** Null closes the drawer. */
  integration: Integration | null;
  onClose: () => void;
  /** A sentence for the page's toast, after the write went through. */
  onSaved: (summary: string) => void;
}

/**
 * The fields. Split from the drawer so `key` on it remounts the form — and so
 * resets `initialValues` — whenever a different integration is opened.
 */
function FormBody({
  integration,
  busy,
  error,
  onDismissError,
  onSubmit,
  onInvalid,
}: {
  integration: Integration;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onSubmit: (values: IntegrationFormValues) => void;
  onInvalid: () => void;
}) {
  const [form] = Form.useForm<IntegrationFormValues>();
  // The weekday and day-of-month fields only mean something for one frequency
  // each, so the form watches it rather than showing four dead controls.
  const frequency = Form.useWatch("frequency", form) ?? integration.schedule.frequency;

  const settings = integration.settings;
  /** The registrable domain the server pins this provider's base URL to. */
  const domain = PROVIDER_BASE_URL_DOMAINS[integration.provider];
  const note = INTEGRATION_NOTES[integration.key];

  return (
    <Form<IntegrationFormValues>
      form={form}
      name={FORM_NAME}
      layout="vertical"
      disabled={busy}
      requiredMark="optional"
      initialValues={{
        baseUrl: integration.baseUrl,
        isEnabled: integration.isEnabled,
        frequency: integration.schedule.frequency,
        // A `Dayjs` is what `TimePicker` speaks; only the hour and minute are
        // ever read back, so the date it carries is irrelevant.
        time: dayjs().hour(integration.schedule.hour).minute(integration.schedule.minute).second(0),
        weekday: integration.schedule.weekday,
        dayOfMonth: integration.schedule.dayOfMonth,
        timezone: integration.schedule.timezone,
        catalogs: settings.catalogs ?? [...CATALOG_TARGETS],
        batchSize: settings.batchSize ?? QUOTE_BATCH_SIZE_DEFAULT,
        creditsPerMinute: settings.creditsPerMinute ?? QUOTE_CREDITS_PER_MINUTE_DEFAULT,
        includeExpired: settings.includeExpired ?? false,
        maxRequestsPerRun: settings.maxRequestsPerRun ?? ALPHA_VANTAGE_REQUESTS_PER_RUN_DEFAULT,
        requestsPerMinute: settings.requestsPerMinute ?? ALPHA_VANTAGE_REQUESTS_PER_MINUTE_DEFAULT,
        days: settings.days ?? COST_DAYS_DEFAULT,
        componentTag: settings.componentTag ?? COST_COMPONENT_TAG_DEFAULT,
        // Empty, not a placeholder name: unset means "the first budget the
        // account has", which is right while there is exactly one.
        budgetName: settings.budgetName ?? "",
        metricsDays: settings.metricsDays ?? POOL_METRICS_DAYS_DEFAULT,
        months: settings.months ?? ALLOCATION_MONTHS_DEFAULT,
        fixedFloorShare: settings.fixedFloorShare ?? FIXED_FLOOR_SHARE_DEFAULT,
      }}
      onFinish={onSubmit}
      onFinishFailed={onInvalid}
      className="flex flex-col gap-4"
    >
      {error !== null && (
        <Alert type="error" showIcon closable onClose={onDismissError} title={error} />
      )}

      <FormSection title="Provider" icon={<ApiOutlined />} color={INTEGRATIONS_COLOR}>
        <Typography.Text type="secondary" className="text-xs">
          {integration.description}
        </Typography.Text>

        {note !== undefined && (
          <Alert type="info" showIcon title="This one is a fallback" description={note} />
        )}

        <Form.Item
          name="baseUrl"
          label="Base URL"
          tooltip={`The provider's address. Paths are appended by the code, so this is the root only. It must stay on ${domain}: an address pointed elsewhere would be a way to read the API key.`}
          extra={
            <span className="text-xs">
              Must be an https:// address on <code>{domain}</code> ({providerLabel(integration.provider)}
              &apos;s own domain), or a subdomain of it.
            </span>
          }
          rules={[
            { required: true, whitespace: true, message: "Base URL is required" },
            {
              // The server refuses anything but https (see httpsUrl in
              // src/lib/integrations/schemas.ts); catching it here beats a
              // run failing at 3 a.m.
              pattern: /^https:\/\/\S+$/i,
              message: "Must be an https:// address on the provider's domain",
            },
          ]}
        >
          <Input placeholder={integration.baseUrl} maxLength={300} autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="isEnabled"
          label="Enabled"
          valuePropName="checked"
          tooltip="A disabled integration never runs on its own and refuses Run now."
        >
          <Switch />
        </Form.Item>

        {integration.requiresApiKey && !integration.apiKeyConfigured && (
          <Alert
            type="warning"
            showIcon
            title={`Key missing: set ${integration.apiKeyEnv ?? "the provider's key"} in .env`}
            description="Until it is set the provider refuses every call, and Run now is answered with an error."
          />
        )}
      </FormSection>

      <FormSection title="Schedule" icon={<ClockCircleOutlined />} color={INTEGRATIONS_COLOR}>
        <Form.Item
          name="frequency"
          label="Frequency"
          tooltip="Off keeps the integration manual-only; Run now still works."
        >
          <Select<ScheduleFrequency>
            style={{ width: 220 }}
            options={SCHEDULE_FREQUENCIES.map((value) => ({ value, label: FREQUENCY_LABELS[value] }))}
          />
        </Form.Item>

        {frequency === "weekly" && (
          <Form.Item name="weekday" label="Day of the week">
            <Select<number>
              style={{ width: 220 }}
              options={WEEKDAY_NAMES.map((label, value) => ({ value, label }))}
            />
          </Form.Item>
        )}

        {frequency === "monthly" && (
          <Form.Item
            name="dayOfMonth"
            label="Day of the month"
            tooltip="1 to 28, so every month has the day."
            rules={[{ required: true, message: "A day between 1 and 28 is required" }]}
          >
            <InputNumber min={1} max={28} style={{ width: 120 }} />
          </Form.Item>
        )}

        <Form.Item
          name="time"
          label="Time"
          tooltip="Wall-clock time in the timezone below."
          rules={[{ required: true, message: "A time is required" }]}
        >
          <TimePicker format="HH:mm" needConfirm={false} style={{ width: 140 }} />
        </Form.Item>

        <Form.Item
          name="timezone"
          label="Timezone"
          tooltip="An IANA name. The list is a shortlist; any valid name can be typed."
          rules={[{ required: true, whitespace: true, message: "A timezone is required" }]}
        >
          <AutoComplete
            style={{ width: 260 }}
            options={TIMEZONE_OPTIONS.map((value) => ({ value }))}
            filterOption={(input, option) =>
              (option?.value ?? "").toLowerCase().includes(input.toLowerCase())
            }
            placeholder="America/Toronto"
          />
        </Form.Item>

        {frequency === "off" && (
          <Typography.Text type="secondary" className="text-xs">
            Nothing runs on its own while the frequency is Off. The time and timezone are kept for
            when it is turned back on.
          </Typography.Text>
        )}
      </FormSection>

      {integration.key === "twelvedata_catalogs" && (
        <FormSection title="Catalogs" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="catalogs"
            label="Lists to download"
            tooltip="Only rows the admin catalog does not have yet are inserted; nothing existing is changed or removed."
            rules={[{ required: true, message: "Pick at least one catalog" }]}
          >
            <Checkbox.Group
              options={CATALOG_TARGETS.map((value) => ({ value, label: CATALOG_LABELS[value] }))}
            />
          </Form.Item>
          <Typography.Text type="secondary" className="text-xs">
            New rows arrive marked <strong>Not pushed</strong> in the Constants sync ledger, so the
            Constants page decides when they reach the main app.
          </Typography.Text>
        </FormSection>
      )}

      {integration.key === "twelvedata_quotes" && (
        <FormSection title="Pacing" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="batchSize"
            label="Symbols per request"
            tooltip={`TwelveData accepts up to ${QUOTE_BATCH_SIZE_MAX} symbols per /quote call and charges one credit per symbol.`}
            rules={[{ required: true, message: "A batch size is required" }]}
          >
            <InputNumber min={1} max={QUOTE_BATCH_SIZE_MAX} style={{ width: 120 }} />
          </Form.Item>

          <Form.Item
            name="creditsPerMinute"
            label="Credits per minute"
            tooltip="The plan's per-minute allowance. The run paces its batches to stay inside it."
            rules={[{ required: true, message: "An allowance is required" }]}
          >
            <InputNumber min={1} max={10_000} style={{ width: 120 }} />
          </Form.Item>

          <Typography.Text type="secondary" className="text-xs">
            The free plan allows 8 credits a minute and 800 a day, and one credit is one symbol — so
            8 symbols per request at 8 credits a minute is one request a minute, and 800 symbols is
            the most a day can cover.
          </Typography.Text>
        </FormSection>
      )}

      {integration.key === "iso_mic_markets" && (
        <FormSection title="MIC register" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="includeExpired"
            label="Include expired MICs"
            valuePropName="checked"
            tooltip="The register marks each code ACTIVE, UPDATED or EXPIRED. Off loads the two live states only."
          >
            <Switch />
          </Form.Item>
          <Typography.Text type="secondary" className="text-xs">
            The register holds about 2 900 codes, roughly 560 of them expired. Only the codes the
            catalog does not already have are inserted, and nothing existing is changed or removed —
            so switching this on later adds the expired ones, and switching it off again does not
            take them away.
          </Typography.Text>
        </FormSection>
      )}

      {integration.key === "alpha_vantage_quotes" && (
        <FormSection title="Quota" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="maxRequestsPerRun"
            label="Requests per run"
            tooltip="One symbol is one request: GLOBAL_QUOTE has no batch form."
            rules={[{ required: true, message: "A cap is required" }]}
          >
            <InputNumber min={1} max={ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX} style={{ width: 120 }} />
          </Form.Item>

          <Form.Item
            name="requestsPerMinute"
            label="Requests per minute"
            tooltip="The tier's per-minute allowance. The pass spaces its requests to stay inside it."
            rules={[{ required: true, message: "An allowance is required" }]}
          >
            <InputNumber
              min={1}
              max={ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX}
              style={{ width: 120 }}
            />
          </Form.Item>

          <Typography.Text type="secondary" className="text-xs">
            Free plan: 25 requests a day, 5 a minute. Leaving the per-run cap below 25 keeps
            headroom for the on-demand lookups, which take at most three each. Symbols past the cap
            keep their TwelveData error and are picked up the next day.
          </Typography.Text>
        </FormSection>
      )}

      {integration.key === "aws_costs" && (
        <FormSection title="Cost Explorer" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="days"
            label="Days of history per run"
            tooltip={`How far back the daily fetch reaches, ending yesterday. The whole window is re-fetched and replaced every run, so a figure AWS revised late is corrected. At most ${COST_FETCH_DAYS_MAX} days: every page of the answer is a charged request.`}
            rules={[{ required: true, message: "A window is required" }]}
          >
            <InputNumber min={1} max={COST_FETCH_DAYS_MAX} style={{ width: 120 }} />
          </Form.Item>

          <Form.Item
            name="componentTag"
            label="Component tag"
            tooltip="The cost allocation tag the month's spend is split by. It must be activated once in the AWS Billing console before AWS will group by it, and activation is not retroactive."
            rules={[
              { required: true, whitespace: true, message: "A tag key is required" },
              { max: 128, message: "A tag key is at most 128 characters" },
            ]}
          >
            <Input placeholder={COST_COMPONENT_TAG_DEFAULT} maxLength={128} autoComplete="off" />
          </Form.Item>

          <Form.Item
            name="budgetName"
            label="Budget name"
            tooltip="Which AWS budget the header meter reads, when the account has more than one. Leave it empty to use the first budget DescribeBudgets returns."
            rules={[{ max: 100, message: "A budget name is at most 100 characters" }]}
          >
            <Input placeholder="the first budget on the account" maxLength={100} autoComplete="off" />
          </Form.Item>

          <Typography.Text type="secondary" className="text-xs">
            Cost Explorer charges <strong>$0.01 per request</strong> and this job is the only thing
            in the console that calls it: three charged requests a run, plus one more on the first
            three days of a month, so about $1 a month at one run a day. The Cost center page itself
            reads the cached rows and costs nothing.
          </Typography.Text>
        </FormSection>
      )}

      {integration.key === "cognito_directory" && (
        <FormSection title="Pool metrics" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="metricsDays"
            label="Days of CloudWatch counters"
            tooltip={`How many days of the customer pool's sign-in and sign-up counters each run re-fetches, ending yesterday. At most ${POOL_METRICS_DAYS_MAX}, which is how long CloudWatch keeps a one-day period.`}
            rules={[{ required: true, message: "A window is required" }]}
          >
            <InputNumber min={1} max={POOL_METRICS_DAYS_MAX} style={{ width: 120 }} />
          </Form.Item>
          <Typography.Text type="secondary" className="text-xs">
            The pool snapshot and the lifecycle diff are not configurable: reading the whole pool
            and comparing it with the previous snapshot is what the run <em>is</em>, and Cognito has
            no deletion event, so a narrowed window would make the event log lie.
            <code>GetMetricData</code> is free, so a wider window only costs a bigger response.
          </Typography.Text>
        </FormSection>
      )}

      {integration.key === "allocate_costs" && (
        <FormSection title="Allocation" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Form.Item
            name="months"
            label="Months recomputed per run"
            tooltip={`How many months each run divides up, ending with the current one. Every month in the window is recomputed from scratch, so a wider window only costs time — nothing here calls AWS. At most ${ALLOCATION_MONTHS_MAX}: Cost Explorer keeps about fourteen months, and a month further back has no cached bill to divide.`}
            rules={[{ required: true, message: "A window is required" }]}
          >
            <InputNumber min={1} max={ALLOCATION_MONTHS_MAX} style={{ width: 120 }} />
          </Form.Item>

          <Form.Item
            name="fixedFloorShare"
            label="Per-tenant floor of the shared pool"
            tooltip="The share of the shared-capacity pool every tenant still live at the end of the month is given before the remainder is split by measured activity. A fraction, not a percentage: 0.005 is half a percent. 0 switches the floor off, so a dormant tenant is allocated nothing at all."
            extra={
              <span className="text-xs">
                A fraction between 0 and {FIXED_FLOOR_SHARE_MAX}. The allocator also caps the
                effective floor at <code>0.5 / tenants</code>, so the floors together never take
                more than half the pool and measured activity always decides the rest.
              </span>
            }
            rules={[{ required: true, message: "A share is required" }]}
          >
            <InputNumber
              min={0}
              max={FIXED_FLOOR_SHARE_MAX}
              step={0.005}
              style={{ width: 140 }}
            />
          </Form.Item>

          <Typography.Text type="secondary" className="text-xs">
            This run makes <strong>no AWS call</strong> and costs nothing: it reads the cost rows
            the <code>aws_costs</code> job cached and the consumer app&apos;s own usage counters,
            and writes the split to <code>admin_tenant_cost_monthly</code>. It needs
            <code>aws_costs</code> to have cached the month first, and says so when it has not.
          </Typography.Text>
        </FormSection>
      )}

      {integration.key === "bank_of_canada_rates" && (
        <FormSection title="Settings" icon={<SettingOutlined />} color={INTEGRATIONS_COLOR}>
          <Typography.Text type="secondary" className="text-xs">
            The Valet API needs no key and has nothing to pace: one call covers every series. There
            is nothing to set here yet.
          </Typography.Text>
        </FormSection>
      )}
    </Form>
  );
}

export default function IntegrationDrawer({ integration, onClose, onSaved }: IntegrationDrawerProps) {
  // Held so the body keeps rendering through the closing animation instead of
  // blanking the instant `integration` goes null.
  const [display, setDisplay] = useState<Integration | null>(integration);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (integration !== null && integration !== display) setDisplay(integration);

  /** Only what actually changed; an empty patch is not sent at all. */
  const buildPatch = (current: Integration, values: IntegrationFormValues): IntegrationPatch => {
    const patch: IntegrationPatch = {};

    const baseUrl = values.baseUrl.trim();
    if (baseUrl !== current.baseUrl) patch.baseUrl = baseUrl;
    if (values.isEnabled !== current.isEnabled) patch.isEnabled = values.isEnabled;

    const next: IntegrationSchedule = {
      frequency: values.frequency,
      hour: values.time.hour(),
      minute: values.time.minute(),
      weekday: values.weekday,
      dayOfMonth: values.dayOfMonth,
      timezone: values.timezone.trim(),
    };
    const schedule: Partial<IntegrationSchedule> = {};
    for (const field of Object.keys(next) as (keyof IntegrationSchedule)[]) {
      if (next[field] !== current.schedule[field]) {
        // One assignment per field would need a cast each time; the record
        // write keeps the union honest without widening the type.
        Object.assign(schedule, { [field]: next[field] });
      }
    }
    if (Object.keys(schedule).length > 0) patch.schedule = schedule;

    // Settings are replaced whole rather than merged: the model is one flat
    // object per integration and each one reads only its own fields.
    switch (current.key) {
      case "twelvedata_catalogs": {
        const catalogs = [...values.catalogs].sort();
        const before = [...(current.settings.catalogs ?? CATALOG_TARGETS)].sort();
        if (catalogs.join(",") !== before.join(",")) patch.settings = { catalogs };
        break;
      }
      case "twelvedata_quotes": {
        const settings: IntegrationSettings = {
          batchSize: values.batchSize,
          creditsPerMinute: values.creditsPerMinute,
        };
        if (
          settings.batchSize !== current.settings.batchSize ||
          settings.creditsPerMinute !== current.settings.creditsPerMinute
        ) {
          patch.settings = settings;
        }
        break;
      }
      case "iso_mic_markets": {
        if (values.includeExpired !== (current.settings.includeExpired ?? false)) {
          patch.settings = { includeExpired: values.includeExpired };
        }
        break;
      }
      case "alpha_vantage_quotes": {
        const settings: IntegrationSettings = {
          maxRequestsPerRun: values.maxRequestsPerRun,
          requestsPerMinute: values.requestsPerMinute,
        };
        if (
          settings.maxRequestsPerRun !== current.settings.maxRequestsPerRun ||
          settings.requestsPerMinute !== current.settings.requestsPerMinute
        ) {
          patch.settings = settings;
        }
        break;
      }
      case "aws_costs": {
        // Trimmed here as well as on the server, so "Component " and
        // "Component" are not seen as a change worth a request.
        const componentTag = values.componentTag.trim();
        const budgetName = values.budgetName.trim();
        const settings: IntegrationSettings = {
          days: values.days,
          componentTag,
          // Sent even when empty: a patch merges into the stored settings, so
          // `""` is the only way to *clear* a pinned budget. The server drops
          // the key rather than storing an empty name.
          budgetName,
        };
        if (
          settings.days !== current.settings.days ||
          componentTag !== (current.settings.componentTag ?? COST_COMPONENT_TAG_DEFAULT) ||
          budgetName !== (current.settings.budgetName ?? "")
        ) {
          patch.settings = settings;
        }
        break;
      }
      case "cognito_directory": {
        if (values.metricsDays !== current.settings.metricsDays) {
          patch.settings = { metricsDays: values.metricsDays };
        }
        break;
      }
      case "allocate_costs": {
        const settings: IntegrationSettings = {
          months: values.months,
          fixedFloorShare: values.fixedFloorShare,
        };
        // Compared against the defaults the form was filled from, so opening
        // the drawer on an integration whose settings row is empty and
        // pressing Save is not a change.
        if (
          settings.months !== (current.settings.months ?? ALLOCATION_MONTHS_DEFAULT) ||
          settings.fixedFloorShare !==
            (current.settings.fixedFloorShare ?? FIXED_FLOOR_SHARE_DEFAULT)
        ) {
          patch.settings = settings;
        }
        break;
      }
      case "bank_of_canada_rates":
        break;
    }

    return patch;
  };

  const handleSubmit = async (values: IntegrationFormValues) => {
    if (display === null) return;
    setError(null);
    const patch = buildPatch(display, values);
    if (Object.keys(patch).length === 0) {
      // Nothing changed: closing quietly is the honest answer.
      onSaved("No changes to save.");
      onClose();
      return;
    }
    setSaving(true);
    try {
      await integrationsApi.update(display.key, patch);
      onSaved(`Saved ${display.name}.`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={integration !== null}
      onClose={onClose}
      afterOpenChange={(open) => {
        if (!open) {
          setDisplay(null);
          setError(null);
        }
      }}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <ApiOutlined style={{ fontSize: 18, color: INTEGRATIONS_COLOR }} />
          <span>{display === null ? "Integration" : `Edit ${display.name}`}</span>
        </span>
      }
      styles={{ body: { background: surfaceColors.page } }}
      footer={
        <div className="flex items-center justify-end">
          <Space>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" form={FORM_NAME} loading={saving}>
              Save
            </Button>
          </Space>
        </div>
      }
    >
      {display === null ? null : (
        <FormBody
          key={display.key}
          integration={display}
          busy={saving}
          error={error}
          onDismissError={() => setError(null)}
          onSubmit={(values) => {
            void handleSubmit(values);
          }}
          onInvalid={() =>
            setError("Some fields need attention. Check the highlighted ones and try again.")
          }
        />
      )}
    </Drawer>
  );
}
