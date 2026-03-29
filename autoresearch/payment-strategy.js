class CreditCardPayment {
  pay(amount) {
    console.log(`Paid $${amount} with Credit Card.`)
  }
}

class PayPalPayment {
  pay(amount) {
    console.log(`Paid $${amount} with PayPal.`)
  }
}

class BankTransferPayment {
  pay(amount) {
    console.log(`Paid $${amount} with Bank Transfer.`)
  }
}

class PaymentContext {
  constructor(strategy) {
    this.strategy = strategy
  }

  setStrategy(strategy) {
    this.strategy = strategy
  }

  processPayment(amount) {
    if (!this.strategy) {
      throw new Error('Payment strategy is not set.')
    }

    this.strategy.pay(amount)
  }
}

const payment = new PaymentContext(new CreditCardPayment())
payment.processPayment(100)

payment.setStrategy(new PayPalPayment())
payment.processPayment(75)

payment.setStrategy(new BankTransferPayment())
payment.processPayment(200)
