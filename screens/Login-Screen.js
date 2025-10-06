// screens/Login-Screen.js
import { signIn, signUp } from '../auth-client.js';

export function LoginScreen(root) {
  root.innerHTML = `
    <div class="auth-card">
      <h1>Sign in to ReachPoint</h1>
      <form id="auth-form">
        <label>Email</label>
        <input id="email" type="email" required autocomplete="email" />
        <label>Password</label>
        <input id="password" type="password" required minlength="6" autocomplete="current-password" />
        <div class="row gap">
          <button type="submit" id="loginBtn">Sign In</button>
          <button type="button" id="signupBtn" class="secondary">Create Account</button>
        </div>
        <p id="authMsg" class="muted" role="status" aria-live="polite"></p>
      </form>
    </div>
  `;

  const form = root.querySelector('#auth-form');
  const email = root.querySelector('#email');
  const password = root.querySelector('#password');
  const msg = root.querySelector('#authMsg');
  const loginBtn = root.querySelector('#loginBtn');
  const signupBtn = root.querySelector('#signupBtn');

  function setBusy(isBusy, text = '') {
    loginBtn.disabled = isBusy;
    signupBtn.disabled = isBusy;
    form.querySelectorAll('input').forEach(i => (i.disabled = isBusy));
    msg.textContent = text;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mail = email.value.trim();
    const pass = password.value;
    if (!mail || !pass) return;

    setBusy(true, 'Signing in…');
    try {
      await signIn(mail, pass);
      msg.textContent = 'Signed in!';
      // Use the same key the router uses
      const key = 'reachpoint.nextPath';
      const next = sessionStorage.getItem(key) || '#/dashboard';
      sessionStorage.removeItem(key);
      location.hash = next;
    } catch (err) {
      msg.textContent = err?.message || 'Login failed';
      setBusy(false);
      password.focus();
      password.select?.();
    }
  });

  signupBtn.addEventListener('click', async () => {
    const mail = email.value.trim();
    const pass = password.value;
    if (!mail || !pass) {
      msg.textContent = 'Enter email and password to create an account.';
      return;
    }

    setBusy(true, 'Creating account…');
    try {
      await signUp(mail, pass);
      msg.textContent = 'Account created. Check your email if confirmations are enabled, then sign in.';
    } catch (err) {
      msg.textContent = err?.message || 'Signup failed';
    } finally {
      setBusy(false);
    }
  });
}
