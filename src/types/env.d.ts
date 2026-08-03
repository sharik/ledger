interface ImportMetaEnv {
  /** Google OAuth client (Web application). Absent ⇒ the Drive option hides. */
  readonly VITE_GOOGLE_CLIENT_ID?: string
  /**
   * Not a secret in a browser client — Google's own guidance is to embed it
   * (see `specs/Technical-Specification.md` §5.5). It exists because the
   * authorization-code flow needs it to return a refresh token.
   */
  readonly VITE_GOOGLE_CLIENT_SECRET?: string
}
