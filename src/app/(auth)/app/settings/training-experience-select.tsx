'use client'

import { Select } from '@/components/ui/Select'

export type TrainingExperience = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED'

const options: { value: TrainingExperience; label: string; description: string }[] = [
  { value: 'BEGINNER', label: 'Beginner', description: 'Starting a running routine' },
  { value: 'INTERMEDIATE', label: 'Intermediate', description: 'Training consistently' },
  { value: 'ADVANCED', label: 'Advanced', description: 'Structured training experience' },
]

export function TrainingExperienceSelect({
  value,
  onChange,
}: {
  value: TrainingExperience
  onChange: (value: TrainingExperience) => void
}) {
  return (
    <Select
      id="profile-experience"
      label="Training experience"
      value={value}
      options={options}
      onChange={onChange}
    />
  )
}
