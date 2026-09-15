# Friction Log — Ring Med Watch

## 1. Ring webhook payload format didn't match initial assumption

**Task attempted:** Build `/webhooks/ring` to detect motion events and reset a "last motion" timer.

**Steps taken:** Initially wrote code checking `req.body.type === 'motion_detected'` at the top level of the incoming JSON, based on a first pass over available docs/examples.

**Expected result:** Motion events from Ring would be correctly detected and update `lastMotionAt`.

**Actual result:** The real Ring webhook payload (v1.1) nests the event type inside `data.type`, not at the root — e.g. `{ "meta": {...}, "data": { "type": "motion_detected", "attributes": {...} } }`. Code checking the root-level field would silently never detect motion from real Ring events, even though local manual tests (which sent a flat payload) passed.

**Severity:** High — this would have caused the entire motion-detection pipeline to fail silently in front of real Ring webhooks while appearing to work in every manual test.

**Workaround used:** Updated the handler to check `event?.data?.type || event?.type`, so it accepts both the real Ring v1.1 format and the flatter format used in earlier manual tests, without breaking either.

**Actionable suggestion:** Ring Playground / getting-started docs could include a minimal, copy-pasteable webhook handler snippet showing the exact nested payload shape expected, right next to the "test your webhook" instructions, so developers don't have to cross-reference the full API reference to get the basic shape right.

## 2. AWS SNS SMS delivery blocked by an account-level restriction, not a permissions error

**Task attempted:** Send SMS alerts via AWS SNS `PublishCommand` with a phone number destination.

**Steps taken:** Added `AmazonSNSFullAccess` to the IAM user, confirmed `PublishCommand` returned success (`"sent":true`), but the SMS never arrived. Investigated via `aws sns get-sms-attributes`, which returned `SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service (Service: PinpointSmsVoiceV2)`.

**Expected result:** Either a clear permissions error (fixable via IAM) or successful SMS delivery.

**Actual result:** SNS accepted and reported success on the publish call, but the underlying delivery service (Pinpoint SMS Voice V2, which SNS now routes SMS through) silently required an account-level service subscription that isn't controlled by IAM policy at all — confirmed billing/payment method was already valid.

**Severity:** High — the `"sent":true` response is misleading; there's no way to detect from the API response alone that delivery is actually blocked.

**Workaround used:** Opened an AWS Support case, and in parallel switched the primary alert channel to AWS SES email, which worked immediately with no account-level restriction (just identity verification), unblocking the project without waiting on Support.

**Actionable suggestion:** The SNS `PublishCommand` response for SMS could include a delivery-eligibility warning field when the underlying account isn't provisioned for Pinpoint SMS Voice V2, rather than returning a bare success that implies delivery will happen.

## 3. Cloud Shell paste corrupts multi-line code with template literals

**Task attempted:** Paste a Node.js file (containing template literals and nested braces) into a Cloud Shell terminal via a heredoc (`cat > file << 'EOF' ... EOF`).

**Expected result:** File written verbatim.

**Actual result:** Cloud Shell's terminal paste handling reordered/merged lines around backticks and braces, producing a corrupted file that failed to run.

**Severity:** Medium — wasted a debugging cycle before the cause (paste handling, not the code itself) was identified.

**Workaround used:** Base64-encoded the file content and piped it through `base64 -d > file` in a single line, which is immune to multi-line paste reordering.

**Actionable suggestion:** Cloud Shell could detect heredoc-style multi-line pastes and warn if line count after paste doesn't match expected line count, or provide a documented "paste-safe" upload path for small text files without requiring `gcloud storage` or the file upload UI.