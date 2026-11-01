-- Pie and donut charts: one more chart type.
ALTER TABLE visualizations DROP CONSTRAINT visualizations_type_check;
ALTER TABLE visualizations ADD CONSTRAINT visualizations_type_check CHECK (
  type IN ('number', 'line', 'area', 'bar', 'share', 'pie', 'heatmap', 'cohort', 'table')
);
