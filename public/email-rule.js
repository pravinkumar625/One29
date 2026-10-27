(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EmailRule = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const EMAIL_REGEX = /^[a-zA-Z]+(?:\.[a-zA-Z]+)*\.s\.129@kalvium\.community$/;
  const ACCESS_DENIED_MESSAGE = 'Access denied. Only authorized student email addresses are permitted.';

  function normalize(email) {
    if (typeof email !== 'string') return '';
    return email.trim();
  }

  function isAuthorizedEmail(email) {
    if (typeof email !== 'string') return false;
    return EMAIL_REGEX.test(email);
  }

  return {
    EMAIL_REGEX,
    regex: EMAIL_REGEX,
    ACCESS_DENIED_MESSAGE,
    message: ACCESS_DENIED_MESSAGE,
    normalize,
    normalizeEmail: normalize,
    isAuthorizedEmail,
  };
});
