const { execSync } = require('child_process')

exports.default = async function (configuration) {
  if (process.env.WIN_SIGN) {
    const { path } = configuration
    if (configuration.path) {
      try {
        const certPath = process.env.ZEN_AI_CERT_PATH || process.env.CHERRY_CERT_PATH
        const keyContainer = process.env.ZEN_AI_CERT_KEY || process.env.CHERRY_CERT_KEY
        const csp = process.env.ZEN_AI_CERT_CSP || process.env.CHERRY_CERT_CSP

        if (!certPath || !keyContainer || !csp) {
          throw new Error(
            'ZEN_AI_CERT_PATH, ZEN_AI_CERT_KEY or ZEN_AI_CERT_CSP is not set (CHERRY_CERT_* fallback is also supported)'
          )
        }

        console.log('Start code signing...')
        console.log('Signing file:', path)
        const signCommand = `signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /v /f "${certPath}" /csp "${csp}" /k "${keyContainer}" "${path}"`
        execSync(signCommand, { stdio: 'inherit' })
        console.log('Code signing completed')
      } catch (error) {
        console.error('Code signing failed:', error)
        throw error
      }
    }
  }
}
