## Contents
* sample-size-calculator.html: The web version of a sample size calculator I developed for a specific use-case, namely when
1) Adding individuals to test groups is costly, while keeping them in control is not (for example, testing a new recommendation model)
2) Multiple test groups are desired
3) A practically significant effect size is known

Given a population size, number of test groups, desired effect size, desired test power, and known variance(s), the calculator determines how large of a test group size is optimal. Note that if adding individuals to the test group is just as costly as control, then this calculator has no real purpose -- balanced groups is ideal in that case.

* optimal_sample_size.ipynb: The original, python function version of the calculator above.

* sensitivity_analysis_sanitized.xlsx: A sanitized version of an excel sheet used to do sensitivity analysis for an encouragement design experiment.
* sensitivity_analysis_math.pdf: Some math proving that the power calculations done the in the above spreadsheet are correct.
