import { Prisma } from "@prisma/client";

export class PayrollCalculationService {
  /**
   * Calculate Gross Salary: Basic + Housing + Transport + Food + Overtime + Bonus + Commission + Reimbursement + Other Earnings
   */
  static calculateGrossSalary(
    basic: number | string | Prisma.Decimal,
    housing: number | string | Prisma.Decimal,
    transport: number | string | Prisma.Decimal,
    food: number | string | Prisma.Decimal,
    overtime: number | string | Prisma.Decimal = 0,
    bonus: number | string | Prisma.Decimal = 0,
    commission: number | string | Prisma.Decimal = 0,
    reimbursement: number | string | Prisma.Decimal = 0,
    otherEarnings: number | string | Prisma.Decimal = 0
  ): Prisma.Decimal {
    const basicDec = new Prisma.Decimal(basic || 0);
    const housingDec = new Prisma.Decimal(housing || 0);
    const transportDec = new Prisma.Decimal(transport || 0);
    const foodDec = new Prisma.Decimal(food || 0);
    const overtimeDec = new Prisma.Decimal(overtime || 0);
    const bonusDec = new Prisma.Decimal(bonus || 0);
    const commissionDec = new Prisma.Decimal(commission || 0);
    const reimbursementDec = new Prisma.Decimal(reimbursement || 0);
    const otherEarningsDec = new Prisma.Decimal(otherEarnings || 0);
    
    return basicDec
      .add(housingDec)
      .add(transportDec)
      .add(foodDec)
      .add(overtimeDec)
      .add(bonusDec)
      .add(commissionDec)
      .add(reimbursementDec)
      .add(otherEarningsDec);
  }

  /**
   * Calculate Total Deduction: Advance + Loan Installment + Leave Deduction + Penalty + Other Deductions
   */
  static calculateTotalDeduction(
    advance: number | string | Prisma.Decimal,
    loanInstallment: number | string | Prisma.Decimal = 0,
    leaveDeduction: number | string | Prisma.Decimal = 0,
    penalty: number | string | Prisma.Decimal = 0,
    otherDeductions: number | string | Prisma.Decimal = 0
  ): Prisma.Decimal {
    const advanceDec = new Prisma.Decimal(advance || 0);
    const loanDec = new Prisma.Decimal(loanInstallment || 0);
    const leaveDec = new Prisma.Decimal(leaveDeduction || 0);
    const penaltyDec = new Prisma.Decimal(penalty || 0);
    const otherDeductionsDec = new Prisma.Decimal(otherDeductions || 0);
    
    return advanceDec
      .add(loanDec)
      .add(leaveDec)
      .add(penaltyDec)
      .add(otherDeductionsDec);
  }

  /**
   * Calculate Net Salary: Gross - Total Deduction (minimum 0)
   */
  static calculateNetSalary(
    gross: number | string | Prisma.Decimal,
    totalDeduction: number | string | Prisma.Decimal
  ): Prisma.Decimal {
    const grossDec = new Prisma.Decimal(gross || 0);
    const totalDeductionDec = new Prisma.Decimal(totalDeduction || 0);
    const net = grossDec.sub(totalDeductionDec);
    return net.lessThan(0) ? new Prisma.Decimal(0) : net;
  }

  /**
   * Validate salary values to ensure none of the fields are negative
   */
  static validateSalaryValues(inputs: Record<string, number | string | Prisma.Decimal | undefined>) {
    for (const [key, value] of Object.entries(inputs)) {
      if (value !== undefined && value !== null) {
        try {
          const dec = new Prisma.Decimal(value);
          if (dec.lessThan(0)) {
            throw new Error(`${key} cannot be negative.`);
          }
        } catch (err: any) {
          if (err.message && err.message.includes("cannot be negative")) {
            throw err;
          }
          throw new Error(`Invalid value for ${key}.`);
        }
      }
    }
  }

  /**
   * Generate snapshot of active SalaryProfile values into a record template
   */
  static generatePayrollSnapshot(profile: any, advanceAmount: number = 0) {
    const basicSalary = new Prisma.Decimal(profile.basicSalary || 0);
    const housingAllowance = new Prisma.Decimal(profile.housingAllowance || 0);
    const transportAllowance = new Prisma.Decimal(profile.transportAllowance || 0);
    const foodAllowance = new Prisma.Decimal(profile.foodAllowance || 0);

    const grossSalary = this.calculateGrossSalary(basicSalary, housingAllowance, transportAllowance, foodAllowance);
    const totalDeduction = this.calculateTotalDeduction(advanceAmount, 0, 0, 0, 0);
    const netSalary = this.calculateNetSalary(grossSalary, totalDeduction);

    return {
      basicSalary,
      housingAllowance,
      transportAllowance,
      foodAllowance,
      grossSalary,
      totalDeduction,
      netSalary,
    };
  }
}
