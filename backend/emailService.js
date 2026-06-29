const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendVerificationEmail({ to, name, code }) {
  const { data, error } = await resend.emails.send({
    from:    process.env.EMAIL_FROM,
    to:      [to],
    subject: `${code} — Your TilMenger verification code`,
    html:    buildEmailHTML(name, code),
  });

  if (error) {
    console.error('[Resend] Send failed:', error);
    throw new Error('Failed to send verification email.');
  }

  console.log(`[Resend] Sent to ${to} — id: ${data.id}`);
  return data;
}

function buildEmailHTML(name, code) {
  const boxStyle = [
    'display:inline-block',
    'width:48px', 'height:56px', 'line-height:56px',
    'text-align:center',
    'background:rgba(255,255,255,0.07)',
    'border:2px solid rgba(212,168,83,0.5)',
    'border-radius:12px',
    "font-family:'Courier New',Courier,monospace",
    'font-size:28px', 'font-weight:700',
    'color:#D4A853',
    'margin:0 4px',
  ].join(';');

  const digitHTML = code.split('').map(d => `<span style="${boxStyle}">${d}</span>`).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Verify your TilMenger account</title>
</head>
<body style="margin:0;padding:0;background-color:#F0EBE3;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0EBE3;">
    <tr><td align="center" style="padding:48px 16px;">

      <table width="560" cellpadding="0" cellspacing="0" border="0"
             style="max-width:560px;width:100%;background:#1A1612;border-radius:24px;overflow:hidden;">

        <!-- top accent bar -->
        <tr>
          <td height="5" style="background:linear-gradient(90deg,#C4572A,#D4A853);font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- header -->
        <tr>
          <td style="padding:40px 48px 28px;text-align:center;">
            <div style="display:inline-block;background:#C4572A;border-radius:16px;padding:14px 18px;margin-bottom:18px;">
              <span style="font-size:30px;line-height:1;">🎓</span>
            </div><br>
            <span style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:#F5F0E8;letter-spacing:-0.5px;">TilMenger</span><br>
            <span style="font-size:11px;color:#4A4540;letter-spacing:3px;text-transform:uppercase;">AI-Powered English Teacher</span>
          </td>
        </tr>

        <!-- divider -->
        <tr><td style="padding:0 48px;"><div style="height:1px;background:rgba(255,255,255,0.08);"></div></td></tr>

        <!-- body -->
        <tr>
          <td style="padding:36px 48px;">
            <p style="margin:0 0 4px;font-size:13px;color:#9A9089;">
              Hello, <strong style="color:#DDD5C8;">${name}</strong> 👋
            </p>
            <h2 style="margin:0 0 16px;font-family:Georgia,serif;font-size:22px;font-weight:400;font-style:italic;color:#F5F0E8;line-height:1.4;">
              Confirm your email address
            </h2>
            <p style="margin:0 0 30px;font-size:14px;color:#9A9089;line-height:1.8;">
              To activate your TilMenger account and start your personalized English learning journey,
              enter the 6-digit code below in the browser window.
            </p>

            <!-- code box -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:18px;padding:28px 20px;text-align:center;">
                  <p style="margin:0 0 18px;font-size:11px;color:#5A5450;letter-spacing:3px;text-transform:uppercase;">
                    Your Verification Code
                  </p>
                  <div style="margin-bottom:18px;">${digitHTML}</div>
                  <p style="margin:0;font-size:12px;color:#5A5450;">
                    Expires in <span style="color:#C4572A;font-weight:600;">10 minutes</span>
                  </p>
                </td>
              </tr>
            </table>

            <!-- level badges -->
            <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:28px;">
              <tr>
                <td align="center">
                  <span style="display:inline-block;background:rgba(74,103,65,0.2);border:1px solid rgba(74,103,65,0.4);border-radius:20px;padding:5px 14px;font-size:12px;color:#8BAF82;margin:3px;">A1–A2 · Beginner</span>
                  <span style="display:inline-block;background:rgba(212,168,83,0.12);border:1px solid rgba(212,168,83,0.3);border-radius:20px;padding:5px 14px;font-size:12px;color:#D4A853;margin:3px;">B1–B2 · Intermediate</span>
                  <span style="display:inline-block;background:rgba(196,87,42,0.15);border:1px solid rgba(196,87,42,0.35);border-radius:20px;padding:5px 14px;font-size:12px;color:#E08060;margin:3px;">C1–C2 · Advanced</span>
                </td>
              </tr>
            </table>

            <p style="margin:28px 0 0;font-size:13px;color:#4A4540;line-height:1.7;">
              If you didn't create a TilMenger account, you can safely ignore this email.
              No account will be created.
            </p>
          </td>
        </tr>

        <!-- footer -->
        <tr><td style="padding:0 48px;"><div style="height:1px;background:rgba(255,255,255,0.07);"></div></td></tr>
        <tr>
          <td style="padding:22px 48px;text-align:center;">
            <p style="margin:0 0 4px;font-size:12px;color:#3A3530;">
              © ${new Date().getFullYear()} TilMenger. All rights reserved.
            </p>
            <p style="margin:0;font-size:11px;color:#2A2520;">
              This is an automated message — please do not reply.
            </p>
          </td>
        </tr>

        <!-- bottom accent bar -->
        <tr>
          <td height="5" style="background:linear-gradient(90deg,#D4A853,#C4572A);font-size:0;line-height:0;">&nbsp;</td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { sendVerificationEmail };